import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'node:crypto';

import { Game, TICK_MS } from './game.js';
import { makeLolzClient, parseThreadId } from './lolz.js';
import { Poller } from './poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LOLZ_TOKEN = process.env.LOLZ_API_TOKEN || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

if (!ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD is not set');
if (!LOLZ_TOKEN) console.warn('[warn] LOLZ_API_TOKEN is not set; lolz polling disabled');

const ADMIN_SECRET = process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('tankz:' + (ADMIN_PASSWORD || 'unset')).digest('hex');

const lolz = LOLZ_TOKEN ? makeLolzClient(LOLZ_TOKEN) : null;

const games = new Map();
const poller = lolz ? new Poller({ lolz, games, log: (...a) => console.log('[poller]', ...a) }) : null;
if (poller) poller.start();

// Game tick loop
setInterval(() => {
  const now = Date.now();
  for (const game of games.values()) {
    if (game.status === 'running') game.tick(now);
  }
}, TICK_MS);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get('/api/games', (req, res) => {
  const list = [...games.values()].map(g => ({
    id: g.id,
    mode: g.mode,
    status: g.status,
    threadId: g.threadId,
    threadUrl: g.threadUrl,
    players: g.players.size,
    createdAt: g.createdAt,
    startedAt: g.startedAt,
    finishedAt: g.finishedAt,
    winnerText: g.winnerText,
  }));
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ games: list });
});

app.get('/api/games/:id', (req, res) => {
  const g = games.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json({ game: g.serialize() });
});

app.post('/api/games', requireAdmin, async (req, res) => {
  const { mode, thread, announce } = req.body || {};
  if (mode !== 'classic' && mode !== 'team') return res.status(400).json({ error: 'mode must be classic or team' });
  const threadId = parseThreadId(thread);
  if (!threadId) return res.status(400).json({ error: 'thread must be a numeric id or thread url' });
  if (!lolz) return res.status(503).json({ error: 'lolz token not configured on server' });

  let threadInfo;
  try {
    threadInfo = await lolz.getThread(threadId);
  } catch (e) {
    return res.status(400).json({ error: `Failed to load thread: ${e.message}` });
  }

  const id = makeGameId();
  const threadUrl = threadInfo.links?.permalink || `https://lolz.live/threads/${threadId}/`;
  const game = new Game({ id, mode, threadId, threadUrl, createdAt: Date.now() });
  games.set(id, game);

  if (announce !== false) {
    const url = `${PUBLIC_BASE_URL}/game/${id}`;
    const body =
      `[B]Tankz live game started[/B] (${mode === 'classic' ? 'all vs all' : 'teams'})\n\n` +
      `Live board: ${url}\n\n` +
      `Commands in this thread:\n` +
      `[LIST]\n` +
      `[*][B]!join[/B]${mode === 'team' ? ' red / !join blue' : ''} — spawn your tank\n` +
      `[*][B]!goto B8[/B] — drive to a cell\n` +
      `[*][B]!shot A1[/B] — fire toward a cell\n` +
      `[*][B]!leave[/B] — remove your tank\n` +
      `[/LIST]\n` +
      `Field: ${game.cols} cols (A..${String.fromCharCode(64 + game.cols)}) x ${game.rows} rows.`;
    lolz.createPost(threadId, body).catch(e => console.warn('[announce] failed:', e.message));
  }

  res.json({ game: game.serialize() });
});

app.post('/api/games/:id/start', requireAdmin, (req, res) => {
  const g = games.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  g.start();
  res.json({ game: g.serialize() });
});

app.post('/api/games/:id/stop', requireAdmin, (req, res) => {
  const g = games.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  g.stop();
  res.json({ game: g.serialize() });
});

app.delete('/api/games/:id', requireAdmin, (req, res) => {
  const g = games.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  g.stop();
  games.delete(req.params.id);
  res.json({ ok: true });
});

// Serve game page for /game/:id (SPA-style).
app.get(['/game/:id', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'game.html'));
});

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

io.on('connection', socket => {
  socket.on('join-game', (id) => {
    const g = games.get(id);
    if (!g) {
      socket.emit('game-error', { id, error: 'not found' });
      return;
    }
    socket.join(`game:${id}`);
    socket.emit('game-state', g.serialize());
  });
});

// Broadcast snapshots a few times per second.
setInterval(() => {
  for (const game of games.values()) {
    io.to(`game:${game.id}`).emit('game-state', game.serialize());
  }
}, 150);

function makeGameId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

server.listen(PORT, () => {
  console.log(`[tankz] listening on http://localhost:${PORT}`);
  console.log(`[tankz] public base: ${PUBLIC_BASE_URL}`);
});
