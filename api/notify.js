// Daily reminder: sends tomorrow's events to Telegram.
// Triggered by the Vercel cron in vercel.json (and manually via /api/notify?key=YOUR_CRON_SECRET).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pecdeiueydbdrdhyhmuv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_6EuBpKeVLzOXFikdomlC7Q_ibBN4Cig';
const DATA_ROW_KEY = 'household-tracker';
const TIMEZONE = 'Asia/Singapore';

const CATEGORY_EMOJI = { mogie: '🔴', juan: '🔵', gareth: '🟢', family: '🟡' };
const CATEGORY_LABEL = { mogie: 'Mogie', juan: 'Juan', gareth: 'Gareth', family: 'Family' };

/* ---------- date helpers (all UTC-based so they never drift with server timezone) ---------- */

function ymd(d) { return d.toISOString().slice(0, 10); }
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000); }

// Today's calendar date in Singapore, shifted by offsetDays, as YYYY-MM-DD
function sgDate(offsetDays) {
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const d = parseYMD(todayStr);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return ymd(d);
}

/* ---------- recurrence logic (mirrors the app) ---------- */

function isRepeating(ev) { return !!ev.repeat && ev.repeat !== 'never'; }

function repeatEndsOn(ev) {
  if (!isRepeating(ev)) return null;
  return ev.endDate && ev.endDate > ev.startDate ? ev.endDate : null;
}

function isOccurrenceStart(ev, dateStr) {
  if (dateStr < ev.startDate) return false;
  const end = repeatEndsOn(ev);
  if (end && dateStr > end) return false;
  const start = parseYMD(ev.startDate);
  const target = parseYMD(dateStr);
  switch (ev.repeat) {
    case 'daily': return true;
    case 'weekly': return daysBetween(start, target) % 7 === 0;
    case 'biweekly': return daysBetween(start, target) % 14 === 0;
    case 'monthly': return target.getUTCDate() === start.getUTCDate();
    case 'yearly':
      return target.getUTCDate() === start.getUTCDate() && target.getUTCMonth() === start.getUTCMonth();
    default: return dateStr === ev.startDate;
  }
}

function eventOccursOn(ev, dateStr) {
  const start = parseYMD(ev.startDate);
  const end = parseYMD(ev.endDate || ev.startDate);
  const durationDays = isRepeating(ev) ? 0 : Math.max(0, daysBetween(start, end));
  const target = parseYMD(dateStr);
  for (let back = 0; back <= durationDays; back++) {
    const cand = new Date(target);
    cand.setUTCDate(cand.getUTCDate() - back);
    const candStr = ymd(cand);
    if (candStr < ev.startDate) break;
    if (isOccurrenceStart(ev, candStr)) return true;
  }
  return false;
}

/* ---------- message formatting ---------- */

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function buildMessage(events, dateStr) {
  const dateLabel = parseYMD(dateStr).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  const lines = [`📅 Tomorrow — ${dateLabel}`, ''];
  events.forEach(e => {
    const emoji = CATEGORY_EMOJI[e.category] || '🟡';
    const who = CATEGORY_LABEL[e.category] || 'Family';
    lines.push(`${emoji} ${e.name} (${who})`);
    if (e.time) lines.push(`   🕐 ${formatTime(e.time)}`);
    if (e.location) lines.push(`   📍 ${e.location}`);
    if (e.remarks) lines.push(`   📝 ${e.remarks}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

/* ---------- I/O ---------- */

async function loadEvents() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/household_data?key=eq.${DATA_ROW_KEY}&select=value`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase responded ${res.status}`);
  const rows = await res.json();
  const events = (rows[0] && rows[0].value && rows[0].value.events) || [];
  // Same migration the app does for older single-date events
  return events.map(e => ({
    ...e,
    startDate: e.startDate || e.date,
    endDate: e.endDate || e.startDate || e.date,
    repeat: e.repeat || 'never',
  }));
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error for chat ${chatId}: ${res.status} ${body}`);
  }
}

/* ---------- handler ---------- */

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!secret || !token || chatIds.length === 0) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS).' });
  }

  const authorised =
    req.headers.authorization === `Bearer ${secret}` ||
    (req.query && req.query.key === secret);
  if (!authorised) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // ?test=1 just proves the Telegram connection works
    if (req.query && req.query.test) {
      for (const id of chatIds) {
        await sendTelegram(token, id, '✅ Mojuan Household reminders are connected. You\'ll get a message each evening when there\'s something on tomorrow.');
      }
      return res.status(200).json({ ok: true, test: true, sentTo: chatIds.length });
    }

    const tomorrow = sgDate(1);
    const events = await loadEvents();
    const tomorrowEvents = events
      .filter(e => eventOccursOn(e, tomorrow))
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    if (tomorrowEvents.length === 0) {
      return res.status(200).json({ ok: true, date: tomorrow, events: 0, sent: false });
    }

    const text = buildMessage(tomorrowEvents, tomorrow);
    for (const id of chatIds) await sendTelegram(token, id, text);
    return res.status(200).json({ ok: true, date: tomorrow, events: tomorrowEvents.length, sent: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
