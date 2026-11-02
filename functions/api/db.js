// Cloudflare Pages Function – /api/db
// Shared data for the daily report (Cloudflare D1, binding name: DB)
//   GET  /api/db          → { ok, rev, savedAt, state }
//   GET  /api/db?meta=1   → { ok, rev, savedAt }
//   PUT  /api/db          body { state, baseRev, force? }
//        → 200 { ok, rev, savedAt }
//        → 409 { ok:false, conflict:true, rev, savedAt, state }  (someone saved first: the page loads this state)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

async function ensureTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, saved_at INTEGER NOT NULL DEFAULT 0)"
  ).run();
}

async function readRow(db) {
  return db.prepare("SELECT state_json, rev, saved_at FROM app_state WHERE id = 1").first();
}

/* optional password: set APP_TOKEN in Cloudflare → Settings → Variables and Secrets */
function denied(request, env) {
  const need = env.APP_TOKEN;
  return need && request.headers.get("x-app-token") !== need ? json({ ok: false, error: "Unauthorized" }, 401) : null;
}

export async function onRequestGet({ request, env }) {
  const d = denied(request, env); if (d) return d;
  try {
    await ensureTable(env.DB);
    const row = await readRow(env.DB);
    const rev = row?.rev ?? 0, savedAt = row?.saved_at ?? 0;
    if (new URL(request.url).searchParams.get("meta") === "1") return json({ ok: true, rev, savedAt });
    return json({ ok: true, rev, savedAt, state: row ? JSON.parse(row.state_json) : null });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const d = denied(request, env); if (d) return d;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.state !== "object" || body.state === null) return json({ ok: false, error: "Invalid state" }, 400);

    await ensureTable(env.DB);
    const stateJson = JSON.stringify(body.state);
    if (stateJson.length > 1900000) return json({ ok: false, error: "State too large for D1 (max ~2 MB)" }, 413);

    const savedAt = Date.now();
    const row = await readRow(env.DB);

    /* first save ever: create the row */
    if (!row) {
      await env.DB.prepare(
        "INSERT INTO app_state (id, state_json, rev, saved_at) VALUES (1, ?, 1, ?) ON CONFLICT(id) DO NOTHING"
      ).bind(stateJson, savedAt).run();
      const now = await readRow(env.DB);
      if (now && now.saved_at === savedAt) return json({ ok: true, rev: now.rev, savedAt });
      return json({ ok: false, conflict: true, rev: now?.rev ?? 0, savedAt: now?.saved_at ?? 0, state: now ? JSON.parse(now.state_json) : null }, 409);
    }

    const force = body.force === true;
    const conflict = cur => json({ ok: false, conflict: true, rev: cur.rev, savedAt: cur.saved_at, state: JSON.parse(cur.state_json) }, 409);

    if (!force && Number(body.baseRev) !== row.rev) return conflict(row);

    const res = force
      ? await env.DB.prepare("UPDATE app_state SET state_json = ?, rev = rev + 1, saved_at = ? WHERE id = 1").bind(stateJson, savedAt).run()
      : await env.DB.prepare("UPDATE app_state SET state_json = ?, rev = rev + 1, saved_at = ? WHERE id = 1 AND rev = ?").bind(stateJson, savedAt, row.rev).run();

    if ((res.meta?.changes ?? 0) !== 1) return conflict(await readRow(env.DB));
    return json({ ok: true, rev: force ? (await readRow(env.DB)).rev : row.rev + 1, savedAt });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
