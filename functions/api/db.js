// Cloudflare Pages Function – /api/db
// Daily-granularity D1 storage with three-way merge and optimistic concurrency.
// Binding required: DB (the existing assy-daily-report D1 database).
// Legacy app_state is deliberately retained after migration as a recovery source.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const now = () => Date.now();
const stable = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
};
const same = (a, b) => stable(a) === stable(b);
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

// Three-way merge by field. Report rows carry stable _id values so array
// edits never depend on their current visual/index position.
function mergeThreeWay(base, current, desired, path, conflicts) {
  if (same(base, desired)) return clone(current);
  if (same(current, base)) return clone(desired);
  if (same(current, desired)) return clone(current);

  const keyed = [base, current, desired].every(v => Array.isArray(v) &&
    v.every(row => row && typeof row === "object" && !Array.isArray(row) && typeof row._id === "string" && row._id));
  if (keyed) {
    const bm = new Map(base.map(x => [x._id, x]));
    const cm = new Map(current.map(x => [x._id, x]));
    const dm = new Map(desired.map(x => [x._id, x]));
    const ids = [...new Set([...base.map(x=>x._id), ...current.map(x=>x._id), ...desired.map(x=>x._id)])];
    const out = [];
    for (const id of ids) {
      const b = bm.get(id), c = cm.get(id), d = dm.get(id);
      const rowPath = `${path || "rows"}[${id}]`;
      // A deletion on one side is safe only if the other side left the row unchanged.
      if (b && !c && d) {
        if (same(b, d)) continue;
        conflicts.push(`${rowPath}.__delete_edit`); out.push(clone(d)); continue;
      }
      if (b && c && !d) {
        if (same(b, c)) continue;
        conflicts.push(`${rowPath}.__edit_delete`); out.push(clone(c)); continue;
      }
      if (!b && c && d) {
        if (same(c, d)) out.push(clone(c));
        else { conflicts.push(`${rowPath}.__add_collision`); out.push(clone(c)); }
        continue;
      }
      if (!b && c) { out.push(clone(c)); continue; }
      if (!b && d) { out.push(clone(d)); continue; }
      if (b && c && d) {
        const row = mergeThreeWay(b, c, d, rowPath, conflicts);
        if (row !== undefined) out.push(row);
      }
    }
    return out;
  }

  if (isObject(base) && isObject(current) && isObject(desired)) {
    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(desired)]);
    for (const key of keys) {
      const value = mergeThreeWay(base[key], current[key], desired[key],
        path ? `${path}.${key}` : key, conflicts);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  conflicts.push(path || "value");
  return clone(current);
}

async function ensureSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS report_days (
    day TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    saved_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS report_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    meta_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    saved_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS report_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    item_key TEXT NOT NULL,
    data_json TEXT,
    version INTEGER NOT NULL,
    saved_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_report_history_scope_key
    ON report_history(scope, item_key, id DESC)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS report_migrations (
    name TEXT PRIMARY KEY,
    completed_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS report_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_day TEXT NOT NULL,
    editor TEXT NOT NULL DEFAULT '',
    field_path TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_report_audit_day_time
    ON report_audit(report_day, created_at DESC, id DESC)`).run();
}

async function migrateLegacy(db) {
  const marker = await db.prepare(
    "SELECT name FROM report_migrations WHERE name = 'daily-v2'"
  ).first();
  if (marker) return;

  const legacy = await db.prepare(
    "SELECT state_json, rev, saved_at FROM app_state WHERE id = 1"
  ).first().catch(() => null);

  let state = null;
  if (legacy?.state_json) {
    try { state = JSON.parse(legacy.state_json); }
    catch { throw new Error("Legacy app_state JSON is invalid; migration stopped without changing it."); }
  }

  const at = now();
  const statements = [];
  if (state && typeof state === "object") {
    const days = state.days && typeof state.days === "object" ? state.days : {};
    for (const [day, value] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO report_days(day, data_json, version, saved_at, updated_by)
         VALUES (?, ?, 1, ?, 'migration')`
      ).bind(day, JSON.stringify(value), Number(legacy.saved_at) || at));
    }
    const meta = { ...state };
    delete meta.days;
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO report_meta(id, meta_json, version, saved_at)
       VALUES (1, ?, ?, ?)`
    ).bind(JSON.stringify(meta), Math.max(1, Number(legacy.rev) || 1), Number(legacy.saved_at) || at));
  } else {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO report_meta(id, meta_json, version, saved_at)
       VALUES (1, '{}', 1, ?)`
    ).bind(at));
  }
  statements.push(db.prepare(
    "INSERT OR IGNORE INTO report_migrations(name, completed_at) VALUES ('daily-v2', ?)"
  ).bind(at));
  if (statements.length) await db.batch(statements);
}

async function ensureReady(db) {
  await ensureSchema(db);
  await migrateLegacy(db);
  await db.prepare(
    "INSERT OR IGNORE INTO report_meta(id, meta_json, version, saved_at) VALUES (1, '{}', 1, ?)"
  ).bind(now()).run();
}

async function readCurrent(db) {
  const [metaRow, rows] = await Promise.all([
    db.prepare("SELECT meta_json, version, saved_at FROM report_meta WHERE id = 1").first(),
    db.prepare("SELECT day, data_json, version, saved_at, updated_by FROM report_days ORDER BY day").all()
  ]);
  const meta = metaRow?.meta_json ? JSON.parse(metaRow.meta_json) : {};
  const days = {};
  let latest = Number(metaRow?.saved_at) || 0;
  for (const row of (rows.results || [])) {
    latest = Math.max(latest, Number(row.saved_at) || 0);
    const value = JSON.parse(row.data_json);
    if (value !== null) days[row.day] = value; // null is a retained tombstone
  }
  return {
    meta,
    state: { ...meta, days, savedAt: Math.max(Number(meta.savedAt) || 0, latest) },
    rev: Number(metaRow?.version) || 0,
    savedAt: latest
  };
}

function mergeMap(base, current, desired, path, conflicts) {
  const out = { ...(current || {}) };
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(current || {}), ...Object.keys(desired || {})]);
  for (const key of keys) {
    const b = base?.[key], c = current?.[key], d = desired?.[key];
    if (same(b, d)) continue;
    if (same(c, b) || same(c, d)) {
      if (d === undefined) delete out[key]; else out[key] = clone(d);
    } else {
      conflicts.push(`${path}.${key}`);
    }
  }
  return out;
}

function mergeMeta(base, current, desired, conflicts) {
  const out = clone(current || {});
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(current || {}), ...Object.keys(desired || {})]);
  for (const key of keys) {
    if (key === "days" || key === "savedAt" || key === "cur") continue;
    const b = base?.[key], c = current?.[key], d = desired?.[key];
    if (same(b, d)) continue;
    if (["settings", "pdfs", "photos"].includes(key) &&
        b && typeof b === "object" && !Array.isArray(b) &&
        c && typeof c === "object" && !Array.isArray(c) &&
        d && typeof d === "object" && !Array.isArray(d)) {
      out[key] = mergeMap(b, c, d, key, conflicts);
    } else if (same(c, b) || same(c, d)) {
      if (d === undefined) delete out[key]; else out[key] = clone(d);
    } else {
      conflicts.push(key);
    }
  }
  // The selected day is a per-browser UI preference, not shared report data.
  if (current?.cur !== undefined) out.cur = current.cur;
  out.savedAt = now();
  return out;
}

function auditDiff(oldValue, newValue, path = "", out = []) {
  if (same(oldValue, newValue)) return out;

  // Xử lý mảng: ghi nhận từng phần tử riêng
  if (Array.isArray(oldValue) || Array.isArray(newValue)) {
    const oldArr = Array.isArray(oldValue) ? oldValue : [];
    const newArr = Array.isArray(newValue) ? newValue : [];
    const max = Math.max(oldArr.length, newArr.length);

    for (let i = 0; i < max; i++) {
      auditDiff(oldArr[i], newArr[i], `${path}[${i}]`, out);
    }
    return out;
  }

  // Xử lý đối tượng: ghi nhận từng trường riêng
  const oldObj = isObject(oldValue);
  const newObj = isObject(newValue);

  if (oldObj || newObj) {
    const oldMap = oldObj ? oldValue : {};
    const newMap = newObj ? newValue : {};
    const keys = new Set([
      ...Object.keys(oldMap),
      ...Object.keys(newMap)
    ]);

    for (const key of keys) {
      auditDiff(
        oldMap[key],
        newMap[key],
        path ? `${path}.${key}` : key,
        out
      );
    }
    return out;
  }

  out.push({
    path: path || "value",
    oldValue,
    newValue
  });

  return out;
}

const auditJson = value => value === undefined ? null : JSON.stringify(value);

async function saveState(db, body) {
  if (!body || !body.state || typeof body.state !== "object" ||
      !body.state.days || typeof body.state.days !== "object" || Array.isArray(body.state.days)) {
    return json({ ok: false, error: "Invalid state.days" }, 400);
  }
  const desiredState = body.state;
  const current = await readCurrent(db);
  const baseState = body.baseState && typeof body.baseState === "object" ? body.baseState : null;

  // Compatibility path for older open browser tabs that do not send baseState.
  if (!baseState && Number(body.baseRev) !== current.rev) {
    return json({ ok: false, conflict: true, rev: current.rev, revision: current.rev,
      savedAt: current.savedAt, state: current.state, conflicts: ["legacy-global-revision"] }, 409);
  }
  // An old tab may not send baseState. If its global revision matches, use the
  // freshly-read server snapshot as its base so the same CAS checks still apply.
  const effectiveBase = baseState || current.state;

  const baseDays = effectiveBase?.days || {};
  const currentDays = current.state.days || {};
  const desiredDays = desiredState.days || {};
  const allDays = new Set([...Object.keys(baseDays), ...Object.keys(currentDays), ...Object.keys(desiredDays)]);
  const conflicts = [];
  const dayWrites = [];

  for (const day of allDays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const b = baseDays[day], d = desiredDays[day];
    if (same(b, d)) continue;
    dayWrites.push({ day, base: b, value: d });
  }

  const mergedMeta = mergeMeta(
    Object.fromEntries(Object.entries(effectiveBase).filter(([k]) => k !== "days")),
    Object.fromEntries(Object.entries(current.state).filter(([k]) => k !== "days")),
    Object.fromEntries(Object.entries(desiredState).filter(([k]) => k !== "days")),
    conflicts
  );

  const currentMeta = current.meta || {};
  const metaChanged = !same(
    Object.fromEntries(Object.entries(mergedMeta).filter(([k]) => k !== "savedAt")),
    Object.fromEntries(Object.entries(currentMeta).filter(([k]) => k !== "savedAt"))
  );

  const at = now();
  const who = String(body.by || "").slice(0, 120);
  const stmts = [];
  const tracked = [];
  let successfulWrites = 0;

  for (const w of dayWrites) {
    let saved = false;
    let dayConflictPaths = [];
    // Retry CAS races so edits to different fields on the same report day can merge.
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      const oldRow = await db.prepare(
        "SELECT data_json, version, saved_at, updated_by FROM report_days WHERE day = ?"
      ).bind(w.day).first();
      const oldJson = oldRow?.data_json ?? null;
      const rawCurrent = oldRow ? JSON.parse(oldJson) : undefined;
      const currentValue = rawCurrent === null ? undefined : rawCurrent;
      const attemptConflicts = [];
      const mergedValue = mergeThreeWay(w.base, currentValue, w.value, `days.${w.day}`, attemptConflicts);
      dayConflictPaths = attemptConflicts;

      if (same(mergedValue, currentValue)) {
        saved = true; // nothing safe to write; any conflicts are returned below
        break;
      }

      const nextJson = JSON.stringify(mergedValue === undefined ? null : mergedValue);
      let result;
      const beforeVersion = Number(oldRow?.version || 0);
      const editor = String(body.by || mergedValue?.writer || "").slice(0, 120);
      const diffs = auditDiff(currentValue, mergedValue);
      const auditStatements = diffs.map(change => db.prepare(
        `INSERT INTO report_audit(report_day,editor,field_path,old_value,new_value,created_at,revision)
         SELECT ?,?,?,?,?,?,? WHERE EXISTS (
           SELECT 1 FROM report_days WHERE day=? AND data_json=? AND version=? AND saved_at=? AND updated_by=?
         )`
      ).bind(w.day, editor, change.path, auditJson(change.oldValue), auditJson(change.newValue), at, beforeVersion + 1,
        w.day, nextJson, beforeVersion + 1, at, editor));
      if (oldRow) {
        result = await db.batch([
          db.prepare(
            `INSERT INTO report_history(scope,item_key,data_json,version,saved_at,updated_by)
             SELECT 'day', day, data_json, version, saved_at, updated_by
             FROM report_days WHERE day=? AND data_json=?`
          ).bind(w.day, oldJson),
          db.prepare(
            `UPDATE report_days SET data_json=?, version=version+1, saved_at=?, updated_by=?
             WHERE day=? AND data_json=?`
          ).bind(nextJson, at, editor, w.day, oldJson),
          ...auditStatements
        ]);
        saved = Number(result[1]?.meta?.changes || 0) === 1;
      } else {
        result = await db.batch([
          db.prepare(
            `INSERT INTO report_days(day,data_json,version,saved_at,updated_by)
             VALUES(?,?,1,?,?) ON CONFLICT(day) DO NOTHING`
          ).bind(w.day, nextJson, at, editor),
          ...auditStatements
        ]);
        saved = Number(result[0]?.meta?.changes || 0) === 1;
      }
      if (saved) {
        successfulWrites++;
        if (dayConflictPaths.length) conflicts.push(...dayConflictPaths);
      }
      // If another request won the compare-and-swap, retry against its new value.
    }
    if (!saved) conflicts.push(`days.${w.day}.concurrent-write`);
  }

  if (metaChanged) {
    const metaRow = await db.prepare("SELECT meta_json FROM report_meta WHERE id=1").first();
    const oldMetaJson = metaRow?.meta_json || "{}";
    if (!same(JSON.parse(oldMetaJson), currentMeta)) {
      conflicts.push("meta.concurrent-update");
    } else {
    stmts.push(db.prepare(
      `INSERT INTO report_history(scope,item_key,data_json,version,saved_at,updated_by)
       SELECT 'meta','global',meta_json,version,saved_at,? FROM report_meta
       WHERE id=1 AND meta_json=?`
    ).bind(who, oldMetaJson));
    stmts.push(db.prepare(
      `UPDATE report_meta SET meta_json=?, saved_at=? WHERE id=1 AND meta_json=?`
    ).bind(JSON.stringify(mergedMeta), at, oldMetaJson));
    tracked.push({ kind: "meta", index: stmts.length - 1 });
    }
  }

  if (stmts.length) {
    const results = await db.batch(stmts);
    for (const t of tracked) {
      const changed = Number(results[t.index]?.meta?.changes || 0);
      if (changed === 1) successfulWrites++;
      else conflicts.push(t.kind === "meta" ? "meta.concurrent-update" : `days.${t.day}`);
    }
  }

  // Increment the global revision for any committed write, including partial
  // success when a different day conflicted. This guarantees other tabs poll it.
  if (successfulWrites) {
    await db.prepare("UPDATE report_meta SET version=version+1, saved_at=? WHERE id=1").bind(at).run();
    for (const t of tracked) {
      const scope = t.kind === "meta" ? "meta" : "day";
      const key = t.kind === "meta" ? "global" : t.day;
      await db.prepare(
        `DELETE FROM report_history WHERE id IN (
          SELECT id FROM report_history WHERE scope=? AND item_key=?
          ORDER BY id DESC LIMIT -1 OFFSET 20
        )`
      ).bind(scope, key).run();
    }
  }

  const latest = await readCurrent(db);
  if (conflicts.length) {
    return json({ ok: false, conflict: true, rev: latest.rev, revision: latest.rev,
      savedAt: latest.savedAt, state: latest.state, conflicts: [...new Set(conflicts)] }, 409);
  }
  return json({ ok: true, rev: latest.rev, revision: latest.rev, savedAt: latest.savedAt, state: latest.state });
}

/* Optional shared attachment storage. Configure an R2 binding named REPORT_FILES.
   Without it, files remain in the browser's IndexedDB and the endpoint reports 503. */
async function handleFile(request, env, id) {
  if (!/^[\w.-]{1,120}$/.test(id)) return json({ ok: false, error: "Invalid file id" }, 400);
  if (!env.REPORT_FILES) return json({ ok: false, error: "Shared file storage is not configured. Add an R2 binding named REPORT_FILES." }, 503);
  const key = `files/${id}`;
  if (request.method === "GET") {
    const obj = await env.REPORT_FILES.get(key);
    if (!obj) return json({ ok: false, error: "Not found" }, 404);
    return new Response(obj.body, { headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": "inline"
    }});
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 5.5 * 1024 * 1024) return json({ ok: false, error: "File too large (max 5.5 MB)" }, 413);
    await env.REPORT_FILES.put(key, buf, { httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream"
    }, customMetadata: { name: decodeURIComponent(request.headers.get("x-file-name") || id).slice(0, 240), savedAt: String(now()) }});
    return json({ ok: true, id, size: buf.byteLength });
  }
  if (request.method === "DELETE") {
    await env.REPORT_FILES.delete(key);
    return json({ ok: true });
  }
  return json({ ok: false, error: "Method not allowed" }, 405);
}

  function denied(request, env) {
  const token = env.APP_TOKEN;

  // Không cho phép truy cập nếu máy chủ chưa cấu hình mật khẩu
  if (!token) {
    return json({
      ok: false,
      error: "Server authentication is not configured"
    }, 500);
  }

  // Từ chối nếu không có token hoặc token không chính xác
  if (request.headers.get("x-app-token") !== token) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  return null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const fileMatch = url.pathname.match(/^\/api\/db\/file\/([^/]+)$/);
  if (fileMatch) {
    const auth = denied(request, env); if (auth) return auth;
    try { return await handleFile(request, env, decodeURIComponent(fileMatch[1])); }
    catch (e) { return json({ ok: false, error: String(e?.message || e) }, 500); }
  }
  const auth = denied(request, env); if (auth) return auth;
  try {
    await ensureReady(env.DB);
    if (url.pathname === "/api/db/audit") {
      const day = url.searchParams.get("day") || "";
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const rows = day
        ? await env.DB.prepare(`SELECT id,report_day,editor,field_path,old_value,new_value,created_at,revision FROM report_audit WHERE report_day=? ORDER BY id DESC LIMIT ?`).bind(day, limit).all()
        : await env.DB.prepare(`SELECT id,report_day,editor,field_path,old_value,new_value,created_at,revision FROM report_audit ORDER BY id DESC LIMIT ?`).bind(limit).all();
      return json({ ok: true, items: rows.results || [] });
    }
    const cur = await readCurrent(env.DB);
    const rev = cur.rev;
    if (url.searchParams.get("meta") === "1") {
      return json({ ok: true, rev, revision: rev, savedAt: cur.savedAt, storage: "daily-v2" });
    }
    return json({ ok: true, rev, revision: rev, savedAt: cur.savedAt, state: cur.state, storage: "daily-v2" });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const url = new URL(request.url);
  const fileMatch = url.pathname.match(/^\/api\/db\/file\/([^/]+)$/);
  if (fileMatch) {
    const auth = denied(request, env); if (auth) return auth;
    try { return await handleFile(request, env, decodeURIComponent(fileMatch[1])); }
    catch (e) { return json({ ok: false, error: String(e?.message || e) }, 500); }
  }
  const auth = denied(request, env); if (auth) return auth;
  try {
    await ensureReady(env.DB);
    const body = await request.json().catch(() => null);
    return await saveState(env.DB, body);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const fileMatch = url.pathname.match(/^\/api\/db\/file\/([^/]+)$/);
  if (!fileMatch) return json({ ok: false, error: "Not found" }, 404);
  const auth = denied(request, env); if (auth) return auth;
  try { return await handleFile(request, env, decodeURIComponent(fileMatch[1])); }
  catch (e) { return json({ ok: false, error: String(e?.message || e) }, 500); }
}
