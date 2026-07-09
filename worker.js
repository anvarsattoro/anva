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

const DAY_ABBR = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DEFAULT_CONFIG = {
  cigarettes_daily_target: 4,
  cigarettes_default_per_day: 7,
  cigarettes_tracking_since: null,
  pre_streak_weekly_drinks: 0,
};

async function loadState(env) {
  const raw = await env.HABITS_KV.get("state");
  return raw ? JSON.parse(raw) : { cigarettes: {}, mood: {}, alcohol_free_since: null, accumulated_sober_days: 0 };
}

async function saveState(env, state) {
  await env.HABITS_KV.put("state", JSON.stringify(state));
}

async function loadConfig(env) {
  const raw = await env.HABITS_KV.get("config");
  return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
}

function daysSince(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00Z"), t = new Date(today + "T00:00:00Z");
  return Math.round((t - d) / 86400000) + 1;
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function cigsForDay(dateStr, today, cigData, cigSince, cigDefault) {
  if (dateStr in cigData) return cigData[dateStr];
  if (dateStr < today && (!cigSince || dateStr < cigSince)) return cigDefault;
  return 0;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function computeDerived(state, config, today) {
  const year = today.slice(0, 4);
  const monthStart = today.slice(0, 7) + "-01";
  const yearStart = year + "-01-01";

  const cigData = state.cigarettes || {};
  const cigSince = config.cigarettes_tracking_since;
  const cigDefault = config.cigarettes_default_per_day;
  const cigTarget = config.cigarettes_daily_target;

  let cigsToday = 0, cigsMonth = 0, cigsYear = 0;
  for (let d = yearStart; d <= today; d = addDays(d, 1)) {
    const v = cigsForDay(d, today, cigData, cigSince, cigDefault);
    cigsYear += v;
    if (d >= monthStart) cigsMonth += v;
    if (d === today) cigsToday = v;
  }

  const alcSince = state.alcohol_free_since || null;
  const alcoholFreeDays = daysSince(alcSince, today);
  let alcMonthDays = 0;
  if (alcSince) {
    const start = alcSince > monthStart ? alcSince : monthStart;
    alcMonthDays = daysSince(start, today) || 0;
  }

  let accumulated = state.accumulated_sober_days || 0;
  if (!accumulated && alcSince) {
    const preDays = Math.max(0, daysSince(yearStart, alcSince) - 1);
    accumulated = Math.round(preDays * Math.max(0, 1 - config.pre_streak_weekly_drinks / 7));
  }
  const yearSoberDays = accumulated + (alcoholFreeDays || 0);
  const yearSoberGoal = isLeapYear(Number(year)) ? 366 : 365;

  const moodDict = state.mood || {};
  const moodWeek = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const dow = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // 0=Пн
    moodWeek.push({ date: d, day: Number(d.slice(8, 10)), label: DAY_ABBR[dow], score: moodDict[d] ?? null });
  }

  return {
    today: {
      alcohol_free_days: alcoholFreeDays,
      cigarettes: cigsToday,
      cigarettes_target: cigTarget,
      mood: moodDict[today] ?? null,
      can_undo_alcohol: !!state.alcohol_undo,
    },
    month: { sobriety_days: alcMonthDays, cigarettes: cigsMonth },
    year: { sobriety_days: yearSoberDays, sobriety_goal: yearSoberGoal, cigarettes: cigsYear },
    mood_week: moodWeek,
  };
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
    const delta = body.delta === -1 ? -1 : 1;
    state.cigarettes[today] = Math.max(0, (state.cigarettes[today] || 0) + delta);
  } else if (body.type === "mood") {
    const score = Number(body.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return new Response(JSON.stringify({ error: "bad score" }), { status: 400 });
    }
    state.mood[today] = score;
  } else if (body.type === "mood_clear") {
    delete state.mood[today];
  } else if (body.type === "alcohol") {
    state.alcohol_undo = {
      alcohol_free_since: state.alcohol_free_since || null,
      accumulated_sober_days: state.accumulated_sober_days || 0,
    };
    const streakStart = state.alcohol_undo.alcohol_free_since;
    if (streakStart) {
      const start = new Date(streakStart + "T00:00:00Z");
      const now = new Date(today + "T00:00:00Z");
      const streak = Math.max(0, Math.round((now - start) / 86400000));
      state.accumulated_sober_days = state.alcohol_undo.accumulated_sober_days + streak;
    }
    const tomorrow = new Date(today + "T00:00:00Z");
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    state.alcohol_free_since = tomorrow.toISOString().slice(0, 10);
  } else if (body.type === "alcohol_undo") {
    if (!state.alcohol_undo) {
      return new Response(JSON.stringify({ error: "nothing to undo" }), { status: 400 });
    }
    state.alcohol_free_since = state.alcohol_undo.alcohol_free_since;
    state.accumulated_sober_days = state.alcohol_undo.accumulated_sober_days;
    delete state.alcohol_undo;
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

async function handleComputed(env) {
  const [state, config] = await Promise.all([loadState(env), loadConfig(env)]);
  const today = todayMoscow();
  const derived = computeDerived(state, config, today);
  return new Response(JSON.stringify(derived), {
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
    if (url.pathname === "/api/computed" && request.method === "GET") {
      return handleComputed(env);
    }
    return env.ASSETS.fetch(request);
  },
};
