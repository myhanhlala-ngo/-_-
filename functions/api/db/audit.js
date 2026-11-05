// Cloudflare Pages Function – GET /api/db/audit?day=YYYY-MM-DD&limit=200
// Read-only audit log endpoint. Uses the existing D1 binding DB and APP_TOKEN.
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
export async function onRequestGet({ request, env }) {
  if (env.APP_TOKEN && request.headers.get("x-app-token") !== env.APP_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS report_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_day TEXT NOT NULL,
      editor TEXT NOT NULL DEFAULT '',
      field_path TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_audit_day_time
      ON report_audit(report_day, created_at DESC, id DESC)`).run();
    const url = new URL(request.url);
    const day = url.searchParams.get("day") || "";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const result = day
      ? await env.DB.prepare(`SELECT id,report_day,editor,field_path,old_value,new_value,created_at,revision
          FROM report_audit WHERE report_day=? ORDER BY id DESC LIMIT ?`).bind(day, limit).all()
      : await env.DB.prepare(`SELECT id,report_day,editor,field_path,old_value,new_value,created_at,revision
          FROM report_audit ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return json({ ok: true, items: result.results || [] });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
}
