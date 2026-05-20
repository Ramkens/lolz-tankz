import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'node:crypto';

import { Match, TICK_MS, formatCell } from './game.js';
import { makeLolzClient, parseThreadId } from './lolz.js';
import { Poller } from './poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LOLZ_TOKEN = process.env.LOLZ_API_TOKEN || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
// Default forum thread to bind the perpetual match to on startup (optional).
const DEFAULT_THREAD = process.env.LOLZ_THREAD || '';

if (!ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD is not set');
if (!LOLZ_TOKEN) console.warn('[warn] LOLZ_API_TOKEN is not set; lolz polling disabled');

const ADMIN_SECRET = process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('tankz:' + (ADMIN_PASSWORD || 'unset')).digest('hex');

const lolz = LOLZ_TOKEN ? makeLolzClient(LOLZ_TOKEN) : null;

// --- the one Match ---
const match = new Match({
  threadId: DEFAULT_THREAD ? parseThreadId(DEFAULT_THREAD) : null,
  threadUrl: DEFAULT_THREAD ? (parseThreadId(DEFAULT_THREAD) ? `https://lolz.live/threads/${parseThreadId(DEFAULT_THREAD)}/` : null) : null,
});

const poller = lolz ? new Poller({ lolz, match, log: (...a) => console.log('[poller]', ...a) }) : null;
if (poller) poller.start();

// Tick loop
setInterval(() => match.tick(Date.now()), TICK_MS);

// Watch for round transitions, announce winners on the forum.
let lastRoundAnnounced = 0;
setInterval(async () => {
  if (!lolz || !match.threadId) return;
  if (match.phase === 'break' && match.roundNumber !== lastRoundAnnounced && match.lastWinner) {
    lastRoundAnnounced = match.roundNumber;
    const w = match.lastWinner;
    const body = composeRoundAnnounce(match.roundNumber, w);
    try {
      await lolz.createPost(match.threadId, body);
    } catch (e) {
      console.warn('[announce] failed:', e.message);
    }
  }
}, 1000);

function composeRoundAnnounce(round, winner) {
  if (winner.kind === 'team') {
    return `[B]:fed: Раунд ${round} — Победила команда ${winner.name.toUpperCase()}![/B]\n` +
           `Киллы команды: [B]${winner.kills}[/B]\n\n` +
           `Следующий раунд через 15 сек. Команды: !join red / !join blue / !goto B8 / !shot A1`;
  }
  if (winner.kind === 'player') {
    return `[B]:fed: Раунд ${round} — Победитель: ${winner.name}![/B]\n` +
           `Киллов: [B]${winner.kills}[/B]\n\n` +
           `Следующий раунд через 15 сек. Команды: !join / !goto B8 / !shot A1`;
  }
  return `[B]Раунд ${round} — ничья[/B]\nСледующий раунд через 15 сек.`;
}

// --- HTTP ---
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, p) {
    // Long-cache assets, but never the entry HTML (avoid stale UI after deploys).
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function isAdmin(req) {
  return req.cookies && req.cookies.admin === ADMIN_SECRET;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'admin only' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'admin password not configured' });
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'invalid password' });
  res.cookie('admin', ADMIN_SECRET, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
    secure: req.protocol === 'https',
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin');
  res.json({ ok: true });
});

app.get('/api/admin/status', (req, res) => {
  res.json({ admin: isAdmin(req), hasLolz: Boolean(lolz) });
});

app.get('/api/state', (req, res) => {
  res.json({ match: match.serialize(), admin: isAdmin(req) });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  match.setSettings(req.body || {});
  res.json({ match: match.serialize() });
});

app.post('/api/admin/thread', requireAdmin, async (req, res) => {
  const { thread } = req.body || {};
  const id = parseThreadId(thread);
  if (!id) return res.status(400).json({ error: 'invalid thread id/url' });
  if (!lolz) return res.status(503).json({ error: 'lolz token not configured' });
  let info;
  try { info = await lolz.getThread(id); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  match.setThread(id, info.links?.permalink || `https://lolz.live/threads/${id}/`);
  res.json({ match: match.serialize() });
});

app.post('/api/admin/announce', requireAdmin, async (req, res) => {
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!lolz || !match.threadId) return res.status(503).json({ error: 'no thread bound' });
  try {
    await lolz.createPost(match.threadId, String(body).slice(0, 5000));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/announce-game', requireAdmin, async (req, res) => {
  if (!lolz || !match.threadId) return res.status(503).json({ error: 'no thread bound' });
  const body = composeGameAnnounce(match, PUBLIC_BASE_URL);
  try {
    await lolz.createPost(match.threadId, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/end-round', requireAdmin, (req, res) => {
  match.forceEndRound();
  res.json({ match: match.serialize() });
});

app.post('/api/admin/reset-scoreboard', requireAdmin, (req, res) => {
  match.resetScoreboard();
  res.json({ match: match.serialize() });
});

app.post('/api/admin/kick', requireAdmin, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  match.removePlayer(userId, 'kicked by admin');
  res.json({ match: match.serialize() });
});

// Admin & root both serve the same SPA shell.
app.get(['/', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

io.on('connection', socket => {
  socket.emit('state', match.serialize());
});

// Push fresh state to every connected client a few times per second.
setInterval(() => {
  io.emit('state', match.serialize());
}, 100);

function composeGameAnnounce(m, baseUrl) {
  const url = baseUrl;
  const mode = m.settings.mode === 'team' ? 'командный (RED vs BLUE)' : 'классика (всех против всех)';
  return (
`[CENTER][B][SIZE=6]:redalert: TANKZ — лайв-битва танков [SIZE=4](правый ствол кофе, выдох в монитор):pivo:[/SIZE][/SIZE][/B][/CENTER]

Сайт: ${url}
Режим: [B]${mode}[/B]
Поле: ${m.cols} клеток в ширину (A..${String.fromCharCode(64 + m.cols)}) x ${m.rows} в высоту (1..${m.rows})
Раунд: [B]${Math.round(m.settings.roundMs / 60000)} мин[/B], респавн ${Math.round(m.settings.respawnMs / 1000)} сек, HP ${m.settings.startingHp}

[CENTER][B]Команды (пишешь прямо в эту тему):[/B][/CENTER]
[LIST]
[*][B]!join[/B] — выйти на поле${m.settings.mode === 'team' ? ' (или [B]!join red[/B] / [B]!join blue[/B])' : ''}
[*][B]!goto B8[/B] — поехать в клетку B8
[*][B]!shot A1[/B] — выстрелить в сторону клетки A1
[*][B]!leave[/B] — увести танк с поля
${m.settings.mode === 'classic' ? '[*][B]!color red|green|blue|black|beige[/B] — поменять цвет\n' : ''}[/LIST]

[CENTER][SIZE=5]:smileforum: Заходи на ${url} — смотри лайв.:cool:[/SIZE][/CENTER]`
  );
}

server.listen(PORT, () => {
  console.log(`[tankz] listening on http://localhost:${PORT}`);
  console.log(`[tankz] public base: ${PUBLIC_BASE_URL}`);
  console.log(`[tankz] thread: ${match.threadId || '(none)'} ${match.threadUrl || ''}`);
});
