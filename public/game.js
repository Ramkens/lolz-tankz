// Sprite-based renderer for the perpetual Tankz match.
// Talks to the server over Socket.IO, draws everything on a single canvas
// with HUD overlays in DOM.

const TANK_COLORS = ['red', 'green', 'blue', 'black', 'beige'];

const sprites = {};
function loadImg(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function loadSprites() {
  const out = { tank: {}, barrel: {}, bullet: {}, env: {}, obstacle: {} };
  await Promise.all([
    ...TANK_COLORS.map(async c => { out.tank[c] = await loadImg(`/assets/tanks/tank_${c}.png`); }),
    ...TANK_COLORS.map(async c => { out.barrel[c] = await loadImg(`/assets/tanks/barrel_${c}.png`); }),
    ...TANK_COLORS.map(async c => { out.bullet[c] = await loadImg(`/assets/bullets/bullet_${c === 'black' ? 'silver' : c}.png`); }),
    (async () => { out.env.grass = await loadImg('/assets/env/grass.png'); })(),
    (async () => { out.env.sand = await loadImg('/assets/env/sand.png'); })(),
    (async () => { out.env.dirt = await loadImg('/assets/env/dirt.png'); })(),
    (async () => { out.env.treeLarge = await loadImg('/assets/env/tree_large.png'); })(),
    (async () => { out.env.treeSmall = await loadImg('/assets/env/tree_small.png'); })(),
    (async () => { out.env.tracks = await loadImg('/assets/tanks/tracks_small.png'); })(),
    (async () => { out.obstacle.barrel_red = await loadImg('/assets/obstacles/barrel_red.png'); })(),
    (async () => { out.obstacle.barrel_green = await loadImg('/assets/obstacles/barrel_green.png'); })(),
    (async () => { out.obstacle.barrel_grey = await loadImg('/assets/obstacles/barrel_grey.png'); })(),
    (async () => { out.obstacle.sandbag_brown = await loadImg('/assets/obstacles/sandbag_brown.png'); })(),
    (async () => { out.obstacle.sandbag_beige = await loadImg('/assets/obstacles/sandbag_beige.png'); })(),
    (async () => { out.obstacle.oil = await loadImg('/assets/obstacles/oil.png'); })(),
  ]);
  return out;
}

// Simple sound bank with mute support.
class Sounds {
  constructor() {
    this.muted = localStorage.getItem('tankz-muted') === '1';
    this.bank = {};
    for (const name of ['shot', 'hit', 'explosion', 'join', 'round_start', 'round_end']) {
      const a = new Audio(`/assets/sfx/${name}.ogg`);
      a.preload = 'auto';
      a.volume = 0.35;
      this.bank[name] = a;
    }
  }
  play(name, volume = 0.35) {
    if (this.muted) return;
    const src = this.bank[name];
    if (!src) return;
    try {
      const a = src.cloneNode();
      a.volume = volume;
      a.play().catch(() => {});
    } catch {}
  }
  toggle() {
    this.muted = !this.muted;
    localStorage.setItem('tankz-muted', this.muted ? '1' : '0');
    return this.muted;
  }
}

// Avatar image cache.
const avatarCache = new Map();
function getAvatar(url) {
  if (!url) return null;
  let img = avatarCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    avatarCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

const formatCell = (col, row) => {
  let n = col + 1, s = '';
  while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s + (row + 1);
};

// Overlay state for transient effects (round winner banner).
let overlayUntil = 0;
const overlay = document.getElementById('overlay');
const overlayKicker = document.getElementById('overlay-kicker');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub = document.getElementById('overlay-sub');

function showOverlay({ kicker, title, sub, kind = 'default', ms = 4500 }) {
  overlay.className = 'overlay ' + kind;
  overlayKicker.textContent = kicker || '';
  overlayTitle.textContent = title || '';
  overlaySub.textContent = sub || '';
  overlay.hidden = false;
  overlayUntil = performance.now() + ms;
}

// Local state derived from server pushes.
let state = null;
let isAdmin = false;
let lastSeenRound = 0;
let lastSeenPhase = null;
const seenFx = new Set();

const sounds = new Sounds();
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('state', s => {
  state = s;

  // Detect transitions for overlay/sound effects
  if (state.phase === 'break' && state.lastWinner && lastSeenRound !== state.roundNumber) {
    lastSeenRound = state.roundNumber;
    sounds.play('round_end', 0.6);
    const w = state.lastWinner;
    if (w.kind === 'team') {
      showOverlay({
        kicker: `Раунд ${state.roundNumber} окончен`,
        title: `КОМАНДА ${w.name.toUpperCase()} ПОБЕДИЛА`,
        sub: `${w.kills} убийств. Следующий раунд скоро.`,
        kind: w.name === 'red' ? 'team-red' : 'team-blue',
      });
    } else if (w.kind === 'player') {
      showOverlay({
        kicker: `Раунд ${state.roundNumber} окончен`,
        title: `🏆 ${w.name}`,
        sub: `${w.kills} убийств. Следующий раунд скоро.`,
        kind: 'winner',
      });
    } else {
      showOverlay({
        kicker: `Раунд ${state.roundNumber} окончен`,
        title: `НИЧЬЯ`,
        sub: `Никто не убил. Следующий раунд скоро.`,
        kind: 'draw',
      });
    }
  }
  if (state.phase === 'running' && lastSeenPhase === 'break') {
    sounds.play('round_start', 0.6);
    showOverlay({
      kicker: 'Старт',
      title: `РАУНД ${state.roundNumber}`,
      sub: `${Math.round(state.settings.roundMs / 60000)} мин боя`,
      kind: 'starting',
      ms: 2000,
    });
  }
  lastSeenPhase = state.phase;

  // Play FX from server-side queue.
  if (state.fx) {
    for (const fx of state.fx) {
      const key = `${fx.kind}:${fx.t}:${fx.x.toFixed(2)}:${fx.y.toFixed(2)}`;
      if (seenFx.has(key)) continue;
      seenFx.add(key);
      if (seenFx.size > 200) seenFx.clear();
      if (fx.kind === 'explosion') sounds.play('explosion', 0.5);
      else if (fx.kind === 'hit') sounds.play('hit', 0.3);
    }
  }

  // Update HUD.
  if (state.admin !== undefined) {
    isAdmin = !!state.admin;
  }
  updateHud(state);
});

// Render loop.
let assets = null;
loadSprites().then(s => { assets = s; requestAnimationFrame(loop); });

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Compute layout so the grid fits inside the viewport with margins.
function layout() {
  const cols = state?.cols || 16;
  const rows = state?.rows || 10;
  const padX = 60, padTop = 80, padBottom = 80;
  const W = window.innerWidth - padX * 2;
  const H = window.innerHeight - padTop - padBottom;
  const cell = Math.floor(Math.min(W / cols, H / rows));
  const gw = cell * cols, gh = cell * rows;
  const ox = Math.floor((window.innerWidth - gw) / 2);
  const oy = padTop + Math.floor((H - gh) / 2);
  return { cell, ox, oy, gw, gh };
}

function drawTiledBackground(lay) {
  const grass = assets.env.grass;
  if (!grass) return;
  const tile = 64;
  ctx.save();
  ctx.beginPath();
  ctx.rect(lay.ox, lay.oy, lay.gw, lay.gh);
  ctx.clip();
  for (let y = lay.oy; y < lay.oy + lay.gh; y += tile) {
    for (let x = lay.ox; x < lay.ox + lay.gw; x += tile) {
      ctx.drawImage(grass, x, y, tile, tile);
    }
  }
  ctx.restore();
}

function drawGridLines(lay) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i <= state.cols; i++) {
    const x = lay.ox + i * lay.cell + 0.5;
    ctx.beginPath(); ctx.moveTo(x, lay.oy); ctx.lineTo(x, lay.oy + lay.gh); ctx.stroke();
  }
  for (let j = 0; j <= state.rows; j++) {
    const y = lay.oy + j * lay.cell + 0.5;
    ctx.beginPath(); ctx.moveTo(lay.ox, y); ctx.lineTo(lay.ox + lay.gw, y); ctx.stroke();
  }
  // Cell labels (A1..Pn) along edges.
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  for (let i = 0; i < state.cols; i++) {
    const letter = String.fromCharCode(65 + i);
    ctx.fillText(letter, lay.ox + i * lay.cell + lay.cell / 2 - 4, lay.oy - 6);
  }
  for (let j = 0; j < state.rows; j++) {
    ctx.fillText(String(j + 1), lay.ox - 16, lay.oy + j * lay.cell + lay.cell / 2 + 4);
  }
  ctx.restore();
}

function drawObstacles(lay) {
  if (!state.obstacles) return;
  for (const o of state.obstacles) {
    const img = assets.obstacle[o.kind];
    if (!img) continue;
    const size = lay.cell * 0.8;
    const x = lay.ox + o.x * lay.cell - size / 2;
    const y = lay.oy + o.y * lay.cell - size / 2;
    ctx.drawImage(img, x, y, size, size);
  }
}

function drawTank(p, lay) {
  const cx = lay.ox + p.x * lay.cell;
  const cy = lay.oy + p.y * lay.cell;
  const tankImg = assets.tank[p.colorKey] || assets.tank.red;
  const barrelImg = assets.barrel[p.colorKey] || assets.barrel.red;
  if (!tankImg) return;

  // Tank body (size = ~1 cell)
  const size = lay.cell * 0.95;
  ctx.save();
  ctx.translate(cx, cy);
  // The Kenney sprite faces up by default; rotate so "up" = -PI/2.
  ctx.rotate(p.facing + Math.PI / 2);
  ctx.globalAlpha = p.alive ? 1 : 0.35;
  ctx.drawImage(tankImg, -size / 2, -size / 2, size, size);
  ctx.restore();

  // Barrel (separate rotation)
  if (barrelImg) {
    const bw = lay.cell * 0.18;
    const bh = lay.cell * 0.62;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((p.barrelAngle ?? p.facing) + Math.PI / 2);
    ctx.globalAlpha = p.alive ? 1 : 0.35;
    ctx.drawImage(barrelImg, -bw / 2, -bh + bw * 0.3, bw, bh);
    ctx.restore();
  }

  // HP bar above tank
  if (p.alive && p.hp < p.maxHp) {
    const barW = lay.cell * 0.6, barH = 4;
    const bx = cx - barW / 2;
    const by = cy - lay.cell * 0.55;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = p.hp >= p.maxHp * 0.66 ? '#22c55e' : p.hp >= p.maxHp * 0.33 ? '#facc15' : '#ef4444';
    ctx.fillRect(bx, by, barW * (p.hp / p.maxHp), barH);
  }

  // Avatar + nickname above tank
  const avatar = getAvatar(p.avatarUrl);
  const labelY = cy - lay.cell * 0.7;
  const avatarSize = lay.cell * 0.32;
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, labelY - avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, cx - avatarSize / 2, labelY - avatarSize, avatarSize, avatarSize);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, labelY - avatarSize / 2, avatarSize / 2 + 1, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.team === 'red' ? '#ef4444' : p.team === 'blue' ? '#3b82f6' : 'rgba(255,255,255,0.7)';
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.font = 'bold 12px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  const name = p.username;
  const tw = ctx.measureText(name).width + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(cx - tw / 2, labelY + 2, tw, 16);
  ctx.fillStyle = p.alive ? '#fff' : 'rgba(255,255,255,0.45)';
  ctx.fillText(name, cx, labelY + 14);
  ctx.restore();

  // Respawn timer overlay
  if (!p.alive && p.respawnAt && state.serverTime) {
    const left = Math.max(0, Math.ceil((p.respawnAt - state.serverTime) / 1000));
    ctx.save();
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(`💥 респаун ${left}c`, cx, cy + lay.cell * 0.5);
    ctx.restore();
  }
}

function drawProjectiles(lay) {
  for (const pr of state.projectiles) {
    const cx = lay.ox + pr.x * lay.cell;
    const cy = lay.oy + pr.y * lay.cell;
    const img = assets.bullet[pr.bulletColor] || assets.bullet.red;
    if (img) {
      const w = lay.cell * 0.18, h = lay.cell * 0.36;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2(pr.dy, pr.dx) + Math.PI / 2);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function loop() {
  if (state && assets) {
    const lay = layout();
    ctx.fillStyle = '#0a0f1d';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    drawTiledBackground(lay);
    drawGridLines(lay);
    drawObstacles(lay);
    for (const p of state.players) drawTank(p, lay);
    drawProjectiles(lay);
  }
  if (overlayUntil && performance.now() > overlayUntil) {
    overlayUntil = 0;
    overlay.hidden = true;
  }
  requestAnimationFrame(loop);
}

// ------- HUD update -------
const $ = id => document.getElementById(id);
function updateHud(s) {
  $('round-num').textContent = String(s.roundNumber);
  if (s.phase === 'running') {
    const left = Math.max(0, s.roundEndsAt - s.serverTime);
    $('round-timer').textContent = formatMs(left);
    $('timer-pill').classList.remove('break');
  } else if (s.phase === 'break') {
    const left = Math.max(0, s.breakEndsAt - s.serverTime);
    $('round-timer').textContent = `пауза ${Math.ceil(left/1000)}с`;
  } else {
    $('round-timer').textContent = '—';
  }
  $('mode-name').textContent = s.settings.mode === 'team' ? 'TEAMS' : 'CLASSIC';
  const tlink = s.threadUrl || '#';
  $('thread-link').href = tlink;
  $('thread-link').textContent = s.threadUrl ? '#' + s.threadId : 'не привязано';
  $('thread-link-bottom').href = tlink;
  $('thread-link-bottom').textContent = s.threadUrl ? '#' + s.threadId : 'нет темы';

  // Scoreboard
  const list = $('scoreboard-list');
  list.innerHTML = '';
  for (const row of s.scoreboard.slice(0, 12)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sb-name">${escapeHtml(row.username)}</span>
      <span class="sb-kills">${row.kills}</span>
      <span class="sb-stat">/${row.deaths}</span>
      <span class="sb-stat">🏆${row.roundsWon}</span>`;
    list.appendChild(li);
  }

  // Event log
  const log = $('event-list');
  log.innerHTML = '';
  for (const e of s.events.slice(-12).reverse()) {
    const li = document.createElement('li');
    li.textContent = e.text;
    if (/killed/i.test(e.text)) li.classList.add('kill');
    if (/Round/i.test(e.text)) li.classList.add('round');
    log.appendChild(li);
  }

  // Admin panel mirror
  if (isAdmin) renderAdminPanel(s);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ------- Admin panel -------
const drawer = $('admin-drawer');
const adminLoginSection = $('admin-login-section');
const adminPanelSection = $('admin-panel-section');

async function refreshAdminStatus() {
  try {
    const r = await fetch('/api/admin/status');
    const j = await r.json();
    isAdmin = !!j.admin;
    showAdminUi();
  } catch {}
}
function showAdminUi() {
  if (isAdmin) {
    adminLoginSection.hidden = true;
    adminPanelSection.hidden = false;
  } else {
    adminLoginSection.hidden = false;
    adminPanelSection.hidden = true;
  }
}

$('open-admin-btn').addEventListener('click', () => {
  drawer.hidden = false;
  refreshAdminStatus();
  if (state) syncSettingsForm(state.settings);
});
$('close-admin').addEventListener('click', () => { drawer.hidden = true; });

$('admin-login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = e.target.password.value;
  const err = $('admin-login-error');
  err.hidden = true;
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || 'ошибка входа';
    err.hidden = false;
    return;
  }
  await refreshAdminStatus();
});

$('admin-logout-btn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  isAdmin = false;
  showAdminUi();
});

$('admin-thread-form').addEventListener('submit', async e => {
  e.preventDefault();
  const thread = $('admin-thread-input').value.trim();
  if (!thread) return;
  const r = await fetch('/api/admin/thread', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread }),
  });
  if (!r.ok) alert((await r.json()).error || 'fail');
});

$('announce-game-btn').addEventListener('click', async () => {
  const r = await fetch('/api/admin/announce-game', { method: 'POST' });
  if (!r.ok) alert((await r.json()).error || 'fail');
});
$('end-round-btn').addEventListener('click', async () => {
  await fetch('/api/admin/end-round', { method: 'POST' });
});
$('reset-scoreboard-btn').addEventListener('click', async () => {
  if (!confirm('Точно сбросить scoreboard?')) return;
  await fetch('/api/admin/reset-scoreboard', { method: 'POST' });
});

$('admin-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const patch = {};
  for (const [k, v] of fd.entries()) {
    if (k === 'mode') patch.mode = v;
    else if (k === 'obstacles') patch.obstacles = true;
    else if (k === 'roundMs' || k === 'breakMs') patch[k] = Number(v) * 1000;
    else patch[k] = Number(v);
  }
  if (!fd.has('obstacles')) patch.obstacles = false;
  const r = await fetch('/api/admin/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    $('admin-settings-error').textContent = j.error || 'fail';
    $('admin-settings-error').hidden = false;
  } else {
    $('admin-settings-error').hidden = true;
  }
});

function syncSettingsForm(settings) {
  const f = $('admin-settings-form');
  f.mode.value = settings.mode;
  f.startingHp.value = settings.startingHp;
  f.tankSpeed.value = settings.tankSpeed;
  f.projectileSpeed.value = settings.projectileSpeed;
  f.shotCooldownMs.value = settings.shotCooldownMs;
  f.respawnMs.value = settings.respawnMs;
  f.roundMs.value = Math.round(settings.roundMs / 1000);
  f.breakMs.value = Math.round(settings.breakMs / 1000);
  f.obstacles.checked = !!settings.obstacles;
}

function renderAdminPanel(s) {
  const ul = $('admin-players');
  ul.innerHTML = '';
  for (const p of s.players) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    if (p.avatarUrl) img.src = p.avatarUrl;
    li.appendChild(img);
    const name = document.createElement('span');
    name.textContent = p.username + (p.team ? ` [${p.team}]` : '');
    li.appendChild(name);
    const btn = document.createElement('button');
    btn.textContent = 'кик';
    btn.onclick = async () => {
      await fetch('/api/admin/kick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: p.userId }),
      });
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
  if (s.threadUrl && !$('admin-thread-input').value) {
    $('admin-thread-input').value = s.threadUrl;
  }
}

// Mute button
const muteBtn = $('mute-btn');
function refreshMuteBtn() { muteBtn.textContent = sounds.muted ? '🔇' : '🔊'; }
refreshMuteBtn();
muteBtn.addEventListener('click', () => { sounds.toggle(); refreshMuteBtn(); });

// Boot
refreshAdminStatus();
// Auto-open admin drawer when navigated to /admin
if (location.pathname === '/admin') {
  drawer.hidden = false;
}
