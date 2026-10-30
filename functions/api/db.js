async function json(data, status = 200) {

  return new Response(JSON.stringify(data), {

    status,

    headers: { "Content-Type": "application/json; charset=utf-8" }

  });

}

export async function onRequestGet({ request, env }) {

  try {

    const row = await env.DB.prepare(

      "SELECT state_json, rev, saved_at FROM app_state WHERE id = 1"

    ).first();

    const rev = row?.rev ?? 0;

    const savedAt = row?.saved_at ?? 0;

    if (new URL(request.url).searchParams.get("meta") === "1") {

      return json({ ok: true, rev, savedAt });

    }

    return json({

      ok: true,

      rev,

      savedAt,

      state: row ? JSON.parse(row.state_json) : { days: {} }

    });

  } catch (error) {

    return json({ ok: false, error: error.message }, 500);

  }

}

export async function onRequestPut({ request, env }) {

  try {

    const body = await request.json();

    if (!body || typeof body.state !== "object" || body.state === null) {

      return json({ ok: false, error: "Invalid state" }, 400);

    }

    const current = await env.DB.prepare(

      "SELECT rev FROM app_state WHERE id = 1"

    ).first();

    const currentRev = current?.rev ?? 0;

    const force = body.force === true;

    if (!force && Number(body.baseRev) !== currentRev) {

      return json({

        ok: false,

        conflict: true,

        rev: currentRev,

        error: "Data has changed on another device"

      }, 409);

    }

    const savedAt = Date.now();

    const stateJson = JSON.stringify(body.state);

    if (force) {

      await env.DB.prepare(`

        INSERT INTO app_state (id, state_json, rev, saved_at)

        VALUES (1, ?, 1, ?)

        ON CONFLICT(id) DO UPDATE SET

          state_json = excluded.state_json,

          rev = app_state.rev + 1,

          saved_at = excluded.saved_at

      `).bind(stateJson, savedAt).run();

    } else {

      const result = await env.DB.prepare(`

        UPDATE app_state

        SET state_json = ?, rev = rev + 1, saved_at = ?

        WHERE id = 1 AND rev = ?

      `).bind(stateJson, savedAt, currentRev).run();

      if (result.meta?.changes !== 1) {

        return json({

          ok: false,

          conflict: true,

          error: "Data changed. Please reload."

        }, 409);

      }

    }

    const updated = await env.DB.prepare(

      "SELECT rev FROM app_state WHERE id = 1"

    ).first();

    return json({

      ok: true,

      rev: updated.rev,

      savedAt

    });

  } catch (error) {

    return json({ ok: false, error: error.message }, 500);

  }

}
