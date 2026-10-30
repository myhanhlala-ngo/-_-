// Shared database for 조립팀 일일 업무 보고 (Netlify Functions v2 + Netlify Blobs)
//
//   GET    /api/db               -> { ok, rev, savedAt, state }       whole report data
//   GET    /api/db?meta=1        -> { ok, rev, savedAt }              cheap "anything new?" check
//   PUT    /api/db               <- { state, baseRev, force? }       save (409 if someone saved first)
//   GET    /api/db/file/:id      -> binary (attached PDF)
//   PUT    /api/db/file/:id      <- binary body, header x-file-name
//   DELETE /api/db/file/:id
//   POST   /api/db/tr            <- { texts:[...], tl:"ko"|"vi"|"en" }  -> { ok, out:[{ t, src }] }  machine translation
//
// Optional protection: set the environment variable APP_TOKEN in Netlify.
// Every request must then send the same value in the header "x-app-token".
// Optional: GOOGLE_TRANSLATE_KEY = API key of Google Cloud Translation (v2). Without it the free
// public endpoint of Google Translate is used (fine for a team report, no SLA).

import { getStore } from "@netlify/blobs";

const STORE = "assy-daily-report";
const STATE_KEY = "state";
const MAX_FILE = 5.5 * 1024 * 1024; // Netlify Functions accept request bodies up to ~6 MB

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const env = (k) => {
  try { if (globalThis.Netlify?.env?.get) return Netlify.env.get(k) || ""; } catch {}
  return process.env[k] || "";
};

const LANGS = ["ko", "vi", "en"];
async function gtx(text, tl) {
  const u = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=" + tl + "&q=" + encodeURIComponent(text);
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("translate " + r.status);
  const j = await r.json();
  return { t: (j[0] || []).map((x) => x[0]).join(""), src: j[2] || "" };
}
async function translate(texts, tl) {
  const key = env("GOOGLE_TRANSLATE_KEY");
  if (key) {
    const r = await fetch("https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(key), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: texts, target: tl, format: "text" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || "translate " + r.status);
    return j.data.translations.map((x) => ({ t: x.translatedText, src: x.detectedSourceLanguage || "" }));
  }
  const out = new Array(texts.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < texts.length) { const i = next++; try { out[i] = await gtx(texts[i], tl); } catch { out[i] = null; } }
  }));
  return out;
}

async function readState(store) {
  const r = await store.getWithMetadata(STATE_KEY, { type: "json" });
  if (!r || r.data == null) return { rev: 0, savedAt: 0, state: null };
  const m = r.metadata || {};
  return { rev: Number(m.rev) || 0, savedAt: Number(m.savedAt) || 0, state: r.data };
}

export default async (req) => {
  const token = env("APP_TOKEN");
  if (token && req.headers.get("x-app-token") !== token) return json({ ok: false, error: "unauthorized", auth: true }, 401);

  const store = getStore({ name: STORE, consistency: "strong" });
  const url = new URL(req.url);
  const sub = url.pathname.replace(/^\/api\/db\/?/, "");

  try {
    /* ---------- machine translation ---------- */
    if (sub === "tr") {
      if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
      const b = await req.json().catch(() => null);
      const tl = b && b.tl, texts = b && Array.isArray(b.texts) ? b.texts.slice(0, 60).map((x) => String(x).slice(0, 4000)) : null;
      if (!texts || !LANGS.includes(tl)) return json({ ok: false, error: "bad body" }, 400);
      return json({ ok: true, out: await translate(texts, tl) });
    }

    /* ---------- attached files ---------- */
    if (sub.startsWith("file/")) {
      const id = decodeURIComponent(sub.slice(5));
      if (!/^[\w.-]{1,120}$/.test(id)) return json({ ok: false, error: "bad id" }, 400);
      const key = "files/" + id;

      if (req.method === "GET") {
        const r = await store.getWithMetadata(key, { type: "arrayBuffer" });
        if (!r || !r.data) return json({ ok: false, error: "not found" }, 404);
        return new Response(r.data, {
          headers: { "content-type": r.metadata?.type || "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" },
        });
      }
      if (req.method === "PUT") {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_FILE) return json({ ok: false, error: "too large" }, 413);
        await store.set(key, buf, {
          metadata: { type: req.headers.get("content-type") || "application/octet-stream", name: decodeURIComponent(req.headers.get("x-file-name") || id), at: Date.now() },
        });
        return json({ ok: true, id, size: buf.byteLength });
      }
      if (req.method === "DELETE") { await store.delete(key); return json({ ok: true }); }
      return json({ ok: false, error: "method" }, 405);
    }

    /* ---------- report data ---------- */
    if (req.method === "GET") {
      const cur = await readState(store);
      if (url.searchParams.get("meta")) return json({ ok: true, rev: cur.rev, savedAt: cur.savedAt });
      return json({ ok: true, ...cur });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.state !== "object" || !body.state || !body.state.days) return json({ ok: false, error: "bad body" }, 400);
      const cur = await readState(store);
      if (!body.force && Number(body.baseRev) !== cur.rev) return json({ ok: false, conflict: true, ...cur }, 409);
      const rev = cur.rev + 1, savedAt = Number(body.state.savedAt) || Date.now();
      await store.setJSON(STATE_KEY, body.state, { metadata: { rev, savedAt } });
      // keep a few older copies so a bad save can be recovered from the Netlify dashboard
      if (cur.state && rev % 20 === 0) await store.setJSON(`backup/${new Date().toISOString().slice(0, 10)}-r${cur.rev}`, cur.state, { metadata: { rev: cur.rev, savedAt: cur.savedAt } });
      return json({ ok: true, rev, savedAt });
    }

    return json({ ok: false, error: "method" }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
};

export const config = { path: ["/api/db", "/api/db/*"] };
