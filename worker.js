/**
 * Статика (index.html, data.json, icon.png) отдаётся через ASSETS.
 * /api/* — живая запись привычек в KV, читается ботом и генератором data.json,
 * чтобы не ждать батч 4 раза в день.
 */
const MOSCOW_TZ = "Europe/Moscow";

function todayMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOSCOW_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function loadState(env) {
  const raw = await env.HABITS_KV.get("state");
  return raw ? JSON.parse(raw) : { cigarettes: {}, mood: {}, alcohol_free_since: null };
}

async function saveState(env, state) {
  await env.HABITS_KV.put("state", JSON.stringify(state));
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { "content-type": "application/json" },
  });
}

async function handleLog(request, env) {
  if (request.headers.get("Authorization") !== `Bearer ${env.WRITE_TOKEN}`) {
    return unauthorized();
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  const state = await loadState(env);
  const today = todayMoscow();

  if (body.type === "cigarette") {
    state.cigarettes[today] = (state.cigarettes[today] || 0) + 1;
  } else if (body.type === "mood") {
    const score = Number(body.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return new Response(JSON.stringify({ error: "bad score" }), { status: 400 });
    }
    state.mood[today] = score;
  } else if (body.type === "alcohol") {
    const streakStart = state.alcohol_free_since;
    const prevAccumulated = state.accumulated_sober_days || 0;
    if (streakStart) {
      const start = new Date(streakStart + "T00:00:00Z");
      const now = new Date(today + "T00:00:00Z");
      const streak = Math.max(0, Math.round((now - start) / 86400000));
      state.accumulated_sober_days = prevAccumulated + streak;
    }
    const tomorrow = new Date(today + "T00:00:00Z");
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    state.alcohol_free_since = tomorrow.toISOString().slice(0, 10);
  } else {
    return new Response(JSON.stringify({ error: "unknown type" }), { status: 400 });
  }

  await saveState(env, state);
  return new Response(JSON.stringify({ ok: true, today, state }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleState(env) {
  const state = await loadState(env);
  return new Response(JSON.stringify(state), {
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/log" && request.method === "POST") {
      return handleLog(request, env);
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      return handleState(env);
    }
    return env.ASSETS.fetch(request);
  },
};
