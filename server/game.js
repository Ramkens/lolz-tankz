// Game state and per-tick simulation.
// All coordinates are in *cell units* (floats). The grid origin (0,0) is the
// top-left cell A1. The grid spans GRID_COLS x GRID_ROWS cells.

export const GRID_COLS = 16; // A..P
export const GRID_ROWS = 10; // 1..10
export const TICK_MS = 100;
export const TANK_SPEED = 2.5; // cells per second
export const PROJECTILE_SPEED = 5; // cells per second
export const TANK_RADIUS = 0.42; // collision radius in cell units
export const PROJECTILE_RADIUS = 0.18;
export const SHOT_COOLDOWN_MS = 1500;
export const STARTING_HP = 3;

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899',
  '#f43f5e', '#84cc16', '#14b8a6', '#0ea5e9', '#8b5cf6',
];
const RED_SHADES = ['#ef4444', '#dc2626', '#b91c1c', '#f87171', '#fca5a5'];
const BLUE_SHADES = ['#3b82f6', '#2563eb', '#1d4ed8', '#60a5fa', '#93c5fd'];

let projectileSeq = 1;

export class Game {
  constructor({ id, mode, threadId, threadUrl, createdAt }) {
    this.id = id;
    this.mode = mode; // 'classic' | 'team'
    this.threadId = threadId;
    this.threadUrl = threadUrl;
    this.status = 'lobby'; // 'lobby' | 'running' | 'finished'
    this.cols = GRID_COLS;
    this.rows = GRID_ROWS;
    this.players = new Map(); // userId(string) -> player
    this.projectiles = [];
    this.events = []; // recent text events, capped
    this.lastPostId = 0;
    this.createdAt = createdAt || Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.winnerText = null;
    this.lastTickAt = Date.now();
    this.tickCount = 0;
    this.commandsApplied = 0;
  }

  // ----- helpers -----
  pushEvent(text) {
    this.events.push({ t: Date.now(), text });
    if (this.events.length > 40) this.events.shift();
  }

  randomFreeCell() {
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(Math.random() * this.cols) + 0.5;
      const y = Math.floor(Math.random() * this.rows) + 0.5;
      let ok = true;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy < 1.5) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
    return { x: Math.random() * this.cols, y: Math.random() * this.rows };
  }

  teamCounts() {
    let red = 0, blue = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    }
    return { red, blue };
  }

  pickColor(team) {
    const used = new Set([...this.players.values()].map(p => p.color));
    const pool = team === 'red' ? RED_SHADES : team === 'blue' ? BLUE_SHADES : PALETTE;
    for (const c of pool) if (!used.has(c)) return c;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ----- mutations driven by commands -----
  addPlayer({ userId, username, avatarUrl, requestedTeam }) {
    const key = String(userId);
    if (this.players.has(key)) {
      const existing = this.players.get(key);
      existing.alive = true;
      existing.hp = STARTING_HP;
      const spot = this.randomFreeCell();
      existing.x = spot.x; existing.y = spot.y;
      existing.targetX = null; existing.targetY = null;
      this.pushEvent(`${username} respawned`);
      return existing;
    }
    let team = null;
    if (this.mode === 'team') {
      if (requestedTeam === 'red' || requestedTeam === 'blue') {
        team = requestedTeam;
      } else {
        const { red, blue } = this.teamCounts();
        if (red < blue) team = 'red';
        else if (blue < red) team = 'blue';
        else team = Math.random() < 0.5 ? 'red' : 'blue';
      }
    }
    const spot = this.randomFreeCell();
    const player = {
      userId: key,
      username,
      avatarUrl: avatarUrl || null,
      team,
      color: this.pickColor(team),
      x: spot.x,
      y: spot.y,
      targetX: null,
      targetY: null,
      facing: -Math.PI / 2, // up
      hp: STARTING_HP,
      alive: true,
      lastShotAt: 0,
      joinedAt: Date.now(),
      kills: 0,
      deaths: 0,
    };
    this.players.set(key, player);
    this.pushEvent(`${username} joined${team ? ' [' + team + ']' : ''}`);
    return player;
  }

  removePlayer(userId, reason = 'left') {
    const key = String(userId);
    const p = this.players.get(key);
    if (!p) return;
    this.players.delete(key);
    this.pushEvent(`${p.username} ${reason}`);
  }

  setTarget(userId, cellX, cellY) {
    const p = this.players.get(String(userId));
    if (!p || !p.alive) return false;
    if (cellX < 0 || cellX >= this.cols || cellY < 0 || cellY >= this.rows) return false;
    p.targetX = cellX + 0.5;
    p.targetY = cellY + 0.5;
    const dx = p.targetX - p.x, dy = p.targetY - p.y;
    if (dx !== 0 || dy !== 0) p.facing = Math.atan2(dy, dx);
    this.pushEvent(`${p.username} → ${formatCell(cellX, cellY)}`);
    return true;
  }

  fire(userId, targetCellX, targetCellY, now) {
    const p = this.players.get(String(userId));
    if (!p || !p.alive) return false;
    if (now - p.lastShotAt < SHOT_COOLDOWN_MS) return false;
    const tx = targetCellX + 0.5;
    const ty = targetCellY + 0.5;
    const dx = tx - p.x, dy = ty - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    p.facing = Math.atan2(uy, ux);
    p.lastShotAt = now;
    this.projectiles.push({
      id: projectileSeq++,
      ownerId: p.userId,
      ownerTeam: p.team,
      x: p.x + ux * 0.5,
      y: p.y + uy * 0.5,
      dx: ux, dy: uy,
      bornAt: now,
    });
    this.pushEvent(`${p.username} fired toward ${formatCell(targetCellX, targetCellY)}`);
    return true;
  }

  // ----- per-tick simulation -----
  tick(now) {
    const dt = Math.min(0.25, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    this.tickCount++;
    if (this.status !== 'running') return;

    // Move tanks
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.targetX == null) continue;
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const dist = Math.hypot(dx, dy);
      const step = TANK_SPEED * dt;
      if (dist <= step) {
        p.x = p.targetX; p.y = p.targetY;
        p.targetX = null; p.targetY = null;
      } else {
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        p.facing = Math.atan2(dy, dx);
      }
    }

    // Move projectiles + collide
    const surviving = [];
    for (const pr of this.projectiles) {
      pr.x += pr.dx * PROJECTILE_SPEED * dt;
      pr.y += pr.dy * PROJECTILE_SPEED * dt;
      if (pr.x < -0.5 || pr.x > this.cols + 0.5 || pr.y < -0.5 || pr.y > this.rows + 0.5) continue;
      let hit = null;
      for (const target of this.players.values()) {
        if (!target.alive) continue;
        if (target.userId === pr.ownerId) continue;
        if (this.mode === 'team' && pr.ownerTeam && target.team === pr.ownerTeam) continue;
        const ddx = target.x - pr.x;
        const ddy = target.y - pr.y;
        if (ddx * ddx + ddy * ddy <= (TANK_RADIUS + PROJECTILE_RADIUS) ** 2) {
          hit = target; break;
        }
      }
      if (hit) {
        hit.hp -= 1;
        const owner = this.players.get(pr.ownerId);
        if (hit.hp <= 0) {
          hit.alive = false;
          hit.deaths++;
          if (owner) owner.kills++;
          this.pushEvent(`${owner ? owner.username : '???'} killed ${hit.username}`);
        } else {
          this.pushEvent(`${owner ? owner.username : '???'} hit ${hit.username} (${hit.hp} HP)`);
        }
        // projectile consumed
      } else {
        surviving.push(pr);
      }
    }
    this.projectiles = surviving;

    // Win condition
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length === 0 && this.players.size > 0) {
      this.status = 'finished';
      this.finishedAt = now;
      this.winnerText = 'Draw — all tanks destroyed';
      this.pushEvent('Draw');
    } else if (this.mode === 'classic' && this.players.size >= 2 && alive.length === 1) {
      this.status = 'finished';
      this.finishedAt = now;
      this.winnerText = `${alive[0].username} wins!`;
      this.pushEvent(this.winnerText);
    } else if (this.mode === 'team' && this.players.size >= 2) {
      const teamsAlive = new Set(alive.map(p => p.team).filter(Boolean));
      if (teamsAlive.size === 1) {
        this.status = 'finished';
        this.finishedAt = now;
        const t = [...teamsAlive][0];
        this.winnerText = `Team ${t.toUpperCase()} wins!`;
        this.pushEvent(this.winnerText);
      }
    }
  }

  start() {
    if (this.status === 'running') return;
    this.status = 'running';
    this.startedAt = Date.now();
    // (Re)spawn everyone fresh
    for (const p of this.players.values()) {
      const spot = this.randomFreeCell();
      p.x = spot.x; p.y = spot.y;
      p.targetX = null; p.targetY = null;
      p.hp = STARTING_HP; p.alive = true;
    }
    this.projectiles = [];
    this.winnerText = null;
    this.pushEvent('Game started');
  }

  stop() {
    if (this.status !== 'finished') {
      this.status = 'finished';
      this.finishedAt = Date.now();
      if (!this.winnerText) this.winnerText = 'Game stopped';
      this.pushEvent('Game stopped');
    }
  }

  serialize() {
    return {
      id: this.id,
      mode: this.mode,
      status: this.status,
      threadId: this.threadId,
      threadUrl: this.threadUrl,
      cols: this.cols,
      rows: this.rows,
      players: [...this.players.values()].map(p => ({
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        team: p.team,
        color: p.color,
        x: p.x, y: p.y,
        targetX: p.targetX, targetY: p.targetY,
        facing: p.facing,
        hp: p.hp,
        alive: p.alive,
        kills: p.kills, deaths: p.deaths,
      })),
      projectiles: this.projectiles.map(pr => ({
        id: pr.id, x: pr.x, y: pr.y, dx: pr.dx, dy: pr.dy, ownerId: pr.ownerId,
      })),
      events: this.events.slice(-15),
      winnerText: this.winnerText,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
}

// "B8" -> { col: 1, row: 7 } (zero-indexed cell). Returns null on bad input.
export function parseCell(token, { cols = GRID_COLS, rows = GRID_ROWS } = {}) {
  if (!token) return null;
  const m = String(token).trim().toUpperCase().match(/^([A-Z]+)\s*([0-9]+)$/);
  if (!m) return null;
  const letters = m[1];
  const number = parseInt(m[2], 10);
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  const row = number - 1;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

export function formatCell(col, row) {
  let label = '';
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    label = String.fromCharCode(65 + r) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label + (row + 1);
}
