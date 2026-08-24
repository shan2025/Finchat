// tools/MissionTool.js — create and manage standing tasks (missions) from chat.
//
// The mission engine already ran standing goals on a schedule; until now the
// only way to CREATE one was the Agents page, so "Rasha, check for PM roles
// every morning and email me" produced a promise no scheduler ever heard about.
// This tool closes that loop: the agent writes the row, the cron tick runs it,
// and the report arrives through the normal notification channels.
//
// Ownership rules, enforced here rather than trusted to the prompt:
//   • every row is scoped to the signed-in user (context.userId)
//   • create assigns the mission to the AGENT THAT IS SPEAKING — an agent
//     cannot hand itself work it has no tools for, or write missions for
//     another agent's domain
//   • list/pause/delete span all of the user's missions, because "cancel my
//     daily job hunt" is a reasonable thing to say to whoever is listening
const { query } = require('../database');
const {
  listMissions, getMission, createMission, updateMission, deleteMission, isValidCadence
} = require('../services/agents/MissionScheduler');

// Missions cost real tokens per run and land in the user's inbox, so the
// catalogue of who may own one is closed.
const KNOWN_AGENTS = new Set(['aurelius', 'rasha', 'nova', 'plato']);

// A mission's token ceiling. The MissionScheduler floor (40k) applies at run
// time regardless; setting it here too means the Agents page shows the number
// the run will actually use instead of a 4000 that was never true.
const DEFAULT_MISSION_TOKENS = 40000;

// Wall-clock times in a cadence phrase are read in this zone. The DB and cron
// are UTC; users say "7am" meaning where they live. Every response states the
// conversion so a wrong assumption is visible and correctable rather than
// silently firing at the wrong hour.
const DEFAULT_TZ_OFFSET_MINUTES = 330; // IST (+05:30)
const TZ_LABELS = { 330: 'IST', 0: 'UTC', '-300': 'EST', '-480': 'PST' };

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6
};

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through to phrase form */ }
  }
  const m = s.match(/^(list|create|update|pause|resume|delete|run_now)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), mission: m[2].trim() || undefined };
  return { action: 'list' };
}

function tzOffsetMinutes(tz) {
  if (tz == null || tz === '') return DEFAULT_TZ_OFFSET_MINUTES;
  if (typeof tz === 'number') return tz;
  const s = String(tz).trim().toUpperCase();
  if (s === 'IST') return 330;
  if (s === 'UTC' || s === 'GMT') return 0;
  const m = s.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  if (m) return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
  return DEFAULT_TZ_OFFSET_MINUTES;
}

function tzLabel(offset) {
  if (TZ_LABELS[offset]) return TZ_LABELS[offset];
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Turn what a person says into a cadence the scheduler understands.
 *
 * Returns { cadence, localTime, note } where `cadence` is a keyword ('daily',
 * '6h', …) or a 5-field UTC cron pattern. Wall-clock times are converted from
 * the caller's zone to UTC here, because that is the only place that knows both
 * numbers — a cron string carries no zone with it.
 */
function normalizeCadence(raw, tzOffset = DEFAULT_TZ_OFFSET_MINUTES) {
  const s = String(raw == null ? 'daily' : raw).trim().toLowerCase();
  if (!s) return { cadence: 'daily' };

  // Already a cadence keyword or a raw cron pattern — pass it through untouched.
  if (['15m', '1h', '6h', 'daily'].includes(s)) return { cadence: s };
  // Five CRON-SHAPED fields. A plain five-word sentence ("whenever you feel
  // like it") also has five fields, and passing that through would store an
  // unfireable pattern that reads as a successfully scheduled task.
  if (/^[\d*,/-]+(\s+[\d*,/-]+){4}$/.test(s)) return { cadence: s };

  // A wall-clock time anywhere in the phrase: "at 7am", "at 19:30", "7:30 pm".
  let hour = null;
  let minute = 0;
  const t = s.match(/(?:at\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (t && (t[3] || t[2] || /\bat\s/.test(s))) {
    hour = parseInt(t[1], 10);
    minute = parseInt(t[2] || '0', 10);
    if (t[3] === 'pm' && hour < 12) hour += 12;
    if (t[3] === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) { hour = null; minute = 0; }
  }

  // "every N hours" / "every N minutes" — interval cadences ignore wall time.
  const iv = s.match(/every\s+(\d+)\s*(minute|min|hour|hr|h|day)s?/);
  if (iv) {
    const n = parseInt(iv[1], 10);
    const unit = iv[2];
    if (/^(minute|min)/.test(unit)) {
      if (n <= 15) return { cadence: '15m', note: 'rounded to the 15-minute floor' };
      return { cadence: `*/${Math.min(n, 59)} * * * *` };
    }
    if (/^(hour|hr|h)/.test(unit)) {
      if (n === 1) return { cadence: '1h' };
      if (n === 6) return { cadence: '6h' };
      return { cadence: `0 */${Math.min(n, 23)} * * *` };
    }
    if (unit === 'day' && n === 1) return dailyAt(hour, minute, tzOffset);
  }

  if (/\bhourly\b/.test(s)) return { cadence: '1h' };
  if (/twice\s+(a\s+)?day|two\s+times\s+a\s+day/.test(s)) {
    const localHour = hour == null ? 8 : hour;
    const { hour: h, minute: mm } = toUtc(localHour, minute, tzOffset);
    return { cadence: `${mm} ${h},${(h + 12) % 24} * * *`, localTime: fmt(localHour, minute), tz: tzOffset };
  }

  // A named weekday, with or without "every": "every monday", "weekly on Friday".
  const dayWord = Object.keys(WEEKDAYS).find(d => new RegExp(`\\b${d}\\b`).test(s));
  if (dayWord || /\bweekly\b|\bevery\s+week\b/.test(s)) {
    const dow = dayWord ? WEEKDAYS[dayWord] : 1; // plain "weekly" → Monday
    const { hour: h, minute: mm, dayShift } = toUtc(hour == null ? 8 : hour, minute, tzOffset);
    const utcDow = (dow + dayShift + 7) % 7;
    return {
      cadence: `${mm} ${h} * * ${utcDow}`,
      localTime: fmt(hour == null ? 8 : hour, minute),
      tz: tzOffset
    };
  }

  if (/\bdaily\b|every\s+day|each\s+day|every\s+morning|each\s+morning|every\s+evening|every\s+night/.test(s) || hour != null) {
    // "every evening/night" with no explicit time defaults to 8pm local.
    const fallback = /evening|night/.test(s) ? 20 : 8;
    return dailyAt(hour == null ? fallback : hour, minute, tzOffset);
  }

  return { cadence: 'daily', note: `could not read "${raw}" as a schedule — defaulted to daily` };
}

function toUtc(hour, minute, tzOffset) {
  const total = hour * 60 + minute - tzOffset;
  const dayShift = Math.floor(total / 1440);
  const norm = ((total % 1440) + 1440) % 1440;
  return { hour: Math.floor(norm / 60), minute: norm % 60, dayShift };
}

function fmt(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function dailyAt(hour, minute, tzOffset) {
  // 08:00 local with no zone shift is exactly the 'daily' keyword, which the
  // scheduler spreads across the hour to keep missions off the same model at
  // the same second. Prefer the keyword when it fits.
  const { hour: h, minute: mm } = toUtc(hour, minute, tzOffset);
  if (h === 8 && mm === 0) return { cadence: 'daily', localTime: fmt(hour, minute), tz: tzOffset };
  return { cadence: `${mm} ${h} * * *`, localTime: fmt(hour, minute), tz: tzOffset };
}

// Shape one row for the model: named fields only, no internal columns.
function view(m) {
  return {
    missionId: m.mission_id,
    title: m.title,
    agent: m.agent_id,
    goal: m.goal,
    cadence: m.cadence,
    enabled: m.enabled,
    lastRunAt: m.last_run_at,
    nextRunAt: m.next_run_at,
    lastResultPreview: m.last_result_preview ? String(m.last_result_preview).slice(0, 200) : null,
    consecutiveFailures: m.consecutive_failures
  };
}

// Find a mission by id, or by a case-insensitive title match. The model
// remembers what it called a task far better than it remembers a uuid.
async function resolve(userId, ref) {
  const needle = String(ref || '').trim();
  if (!needle) return { error: 'Which task? Pass {"mission":"<title or id>"} — use action "list" to see them.' };
  const all = await listMissions(userId);
  const byId = all.find(m => m.mission_id === needle);
  if (byId) return { mission: byId };
  const lower = needle.toLowerCase();
  const exact = all.filter(m => m.title.toLowerCase() === lower);
  const partial = exact.length ? exact : all.filter(m => m.title.toLowerCase().includes(lower));
  if (partial.length === 1) return { mission: partial[0] };
  if (partial.length > 1) {
    return { error: `"${needle}" matches ${partial.length} tasks: ${partial.map(m => m.title).join(', ')}. Use the exact title or the missionId.` };
  }
  return { error: `No task matching "${needle}". Existing tasks: ${all.map(m => m.title).join(', ') || 'none yet'}.` };
}

async function execute(input, context = {}) {
  const opts = parseInput(input);
  const action = String(opts.action || 'list').toLowerCase();
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Standing tasks require a signed-in user — ask the user to sign in.');
  }

  // The acting agent owns anything it creates. An explicit agentId is honoured
  // only if it names a real agent, so a hallucinated "agent":"assistant" cannot
  // orphan a mission onto an id no router will ever match.
  const speaking = String(context.agentId || context.agentName || '').toLowerCase();
  const requested = String(opts.agentId || opts.agent || '').toLowerCase();
  const agentId = KNOWN_AGENTS.has(requested) ? requested
    : (KNOWN_AGENTS.has(speaking) ? speaking : 'plato');

  if (action === 'list') {
    const rows = await listMissions(userId);
    return {
      action: 'list',
      count: rows.length,
      missions: rows.map(view),
      note: rows.length === 0
        ? 'No standing tasks yet. Create one with {"action":"create","title":"…","goal":"…","cadence":"daily"}.'
        : undefined
    };
  }

  if (action === 'create') {
    const title = String(opts.title || '').trim();
    const goal = String(opts.goal || opts.instructions || '').trim();
    if (!title) throw new Error('A task needs a "title" — a short name like "Daily PM job hunt".');
    if (goal.length < 20) {
      throw new Error('A task needs a detailed "goal": the full standing instructions the agent will re-read on every run, with no reference to this conversation (nobody is there to ask). Name the tools to use and what the report should contain.');
    }

    const tz = tzOffsetMinutes(opts.timezone || opts.tz);
    const { cadence, localTime, note } = normalizeCadence(opts.cadence || opts.schedule || opts.when, tz);
    if (!isValidCadence(cadence)) {
      throw new Error(`Could not turn "${opts.cadence || opts.schedule}" into a schedule. Use "daily", "6h", "1h", "15m", a phrase like "every day at 7am", or a 5-field cron pattern.`);
    }

    // Re-asking for the same standing task should not stack duplicates: three
    // "Daily job hunt" rows means three reports and three times the tokens.
    const existing = (await listMissions(userId))
      .find(m => m.agent_id === agentId && m.title.trim().toLowerCase() === title.toLowerCase());
    if (existing) {
      const updated = await updateMission(existing.mission_id, userId, {
        goal, cadence, enabled: opts.enabled === false ? false : true
      });
      return {
        action: 'updated_existing',
        mission: view(updated),
        schedule: describe(cadence, localTime, tz),
        message: `A task called "${title}" already existed for ${agentId} — updated it instead of creating a second one.`
      };
    }

    const mission = await createMission({
      userId,
      agentId,
      title,
      goal,
      cadence,
      // Chat-created tasks start ON. The seeded flagship missions ship disabled
      // because nobody asked for them; this one was just asked for out loud.
      enabled: opts.enabled === false ? false : true,
      maxTokensPerRun: Number(opts.maxTokensPerRun) || DEFAULT_MISSION_TOKENS
    });

    return {
      action: 'create',
      mission: view(mission),
      schedule: describe(cadence, localTime, tz),
      cadenceNote: note,
      delivery: 'Each run is delivered to the notification feed and to whichever channels the user has enabled in Settings (email / Telegram).',
      message: `Standing task "${title}" created for ${agentId} and is now live.`
    };
  }

  if (action === 'pause' || action === 'resume') {
    const { mission, error } = await resolve(userId, opts.mission || opts.missionId || opts.title);
    if (error) return { action, error };
    const updated = await updateMission(mission.mission_id, userId, { enabled: action === 'resume' });
    return { action, mission: view(updated), message: `"${mission.title}" is now ${action === 'resume' ? 'running on its schedule' : 'paused'}.` };
  }

  if (action === 'update') {
    const { mission, error } = await resolve(userId, opts.mission || opts.missionId || opts.title);
    if (error) return { action, error };
    const patch = {};
    if (opts.goal) patch.goal = String(opts.goal);
    if (opts.newTitle) patch.title = String(opts.newTitle);
    if (opts.enabled != null) patch.enabled = !!opts.enabled;
    if (opts.maxTokensPerRun != null) patch.maxTokensPerRun = Number(opts.maxTokensPerRun);
    let localTime; let tz;
    if (opts.cadence || opts.schedule || opts.when) {
      tz = tzOffsetMinutes(opts.timezone || opts.tz);
      const n = normalizeCadence(opts.cadence || opts.schedule || opts.when, tz);
      patch.cadence = n.cadence;
      localTime = n.localTime;
      // updateMission reschedules next_run_at itself when the cadence moves.
    }
    if (!Object.keys(patch).length) {
      return { action, error: 'Nothing to update. Pass goal, newTitle, cadence, enabled or maxTokensPerRun.' };
    }
    const updated = await updateMission(mission.mission_id, userId, patch);
    return {
      action, mission: view(updated),
      schedule: patch.cadence ? describe(patch.cadence, localTime, tz) : undefined,
      message: `Updated "${updated.title}".`
    };
  }

  if (action === 'delete') {
    const { mission, error } = await resolve(userId, opts.mission || opts.missionId || opts.title);
    if (error) return { action, error };
    await deleteMission(mission.mission_id, userId);
    return { action, deleted: true, title: mission.title, message: `Deleted the standing task "${mission.title}".` };
  }

  if (action === 'run_now') {
    const { mission, error } = await resolve(userId, opts.mission || opts.missionId || opts.title);
    if (error) return { action, error };
    if (!mission.enabled) {
      return {
        action,
        error: `"${mission.title}" is paused, so nothing will pick it up. Resume it first with {"action":"resume","mission":"${mission.title}"}.`
      };
    }
    // Queue it rather than running it inline: a mission run is a full research
    // pass with its own 7-minute budget, and it must not be charged to — or
    // time out inside — the chat turn the user is waiting on.
    await query('UPDATE agent_missions SET next_run_at = now(), updated_at = now() WHERE mission_id = $1 AND user_id = $2',
      [mission.mission_id, userId]);
    return {
      action, queued: true, title: mission.title,
      message: `"${mission.title}" is queued and will run on the next scheduler tick (within ~15 minutes). The report arrives in the notification feed, not in this chat.`
    };
  }

  throw new Error(`Unknown mission action "${action}". Use list, create, update, pause, resume, delete or run_now.`);
}

function describe(cadence, localTime, tz) {
  const keyword = { '15m': 'every 15 minutes', '1h': 'every hour', '6h': 'every 6 hours', 'daily': 'once a day (around 08:00 UTC)' };
  if (keyword[cadence] && !localTime) return keyword[cadence];
  if (localTime && tz != null) return `${cadence === 'daily' || /\* \* \*$/.test(cadence) ? 'daily' : 'weekly'} at ${localTime} ${tzLabel(tz)} (cron "${cadence}" UTC)`;
  return `cron "${cadence}" (UTC)`;
}

module.exports = { execute, normalizeCadence, toUtc };
