// One perpetual Match. Players join via forum commands and stay between
// rounds. Each round lasts ROUND_MS, ends with a winner and a short
// between-round break, then auto-resets and starts again. Dead tanks
// respawn after RESPAWN_MS.
//
// All coordinates are in *cell units* (floats). Cell (0,0) center is at (0.5, 0.5).

export const GRID_COLS = 16; // A..P
export const GRID_ROWS = 10; // 1..10
export const TICK_MS = 50;

// Tunable defaults — admin can override at runtime via settings.
export const DEFAULTS = {
  mode: 'classic', // 'classic' | 'team'
  startingHp: 3,
  tankSpeed: 3.0,         // cells / second
  projectileSpeed: 8.0,   // cells / second
  shotCooldownMs: 1200,
  respawnMs: 5000,
  roundMs: 5 * 60 * 1000, // 5 min
  breakMs: 15 * 1000,     // 15 sec between rounds
  tankRadius: 0.40,
  projectileRadius: 0.16,
  obstacles: true,
};

const COLOR_KEYS = ['red', 'green', 'blue', 'black', 'beige'];
const COLOR_HEX = {
  red:   '#e74c3c',
  green: '#2ecc71',
  blue:  '#3498db',
  black: '#34495e',
  beige: '#d6c08a',
};

let projectileSeq = 1;

export class Match {
  constructor(opts = {}) {
    this.cols = GRID_COLS;
    this.rows = GRID_ROWS;
    this.settings = { ...DEFAULTS, ...opts };
    this.threadId = opts.threadId || null;
    this.threadUrl = opts.threadUrl || null;

    this.players = new Map();   // userId -> player
    this.projectiles = [];
    this.obstacles = [];
    this.events = [];           // recent text events {t, text}
    this.lastPostId = 0;        // forum poller cursor

    // Lifetime stats
    this.totals = new Map();    // userId -> {username, kills, deaths, roundsWon}
    this.roundNumber = 0;
    this.phase = 'starting';    // 'running' | 'break' | 'starting'
    this.roundStartedAt = 0;
    this.roundEndsAt = 0;
    this.breakEndsAt = 0;
    this.lastWinner = null;     // { kind: 'player'|'team', name, kills }
    this.lastTickAt = Date.now();
    this.commandsApplied = 0;

    this.placeObstacles();
    this.beginRound();
  }

  // ------- helpers -------
  pushEvent(text) {
    this.events.push({ t: Date.now(), text });
    if (this.events.length > 80) this.events.shift();
  }

  setSettings(patch) {
    if (!patch) return;
    for (const k of Object.keys(this.settings)) {
      if (patch[k] === undefined) continue;
      const v = patch[k];
      if (typeof this.settings[k] === 'number') {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) this.settings[k] = n;
      } else if (typeof this.settings[k] === 'boolean') {
        this.settings[k] = Boolean(v);
      } else {
        this.settings[k] = v;
      }
    }
    if (patch.mode === 'classic' || patch.mode === 'team') {
      this.settings.mode = patch.mode;
    }
    this.pushEvent(`settings updated`);
  }

  setThread(threadId, threadUrl) {
    this.threadId = threadId || null;
    this.threadUrl = threadUrl || null;
    this.lastPostId = 0;
    this.pushEvent(`thread set: ${threadUrl || threadId || 'none'}`);
  }

  placeObstacles() {
    this.obstacles = [];
    if (!this.settings.obstacles) return;
    // A fixed but visually pleasing layout of barrels & sandbags around the
    // middle of the board. Coordinates are cell centers (floats).
    const layout = [
      // central cluster
      { kind: 'barrel_red', x: 7.5, y: 4.5 },
      { kind: 'barrel_green', x: 8.5, y: 4.5 },
      { kind: 'barrel_grey', x: 7.5, y: 5.5 },
      { kind: 'barrel_red', x: 8.5, y: 5.5 },
      // left wing
      { kind: 'sandbag_brown', x: 3.5, y: 2.5 },
      { kind: 'sandbag_brown', x: 3.5, y: 7.5 },
      // right wing
      { kind: 'sandbag_beige', x: 12.5, y: 2.5 },
      { kind: 'sandbag_beige', x: 12.5, y: 7.5 },
      // oil patches (decorative — projectiles ignore them)
      { kind: 'oil', x: 5.5, y: 5.5, decorative: true },
      { kind: 'oil', x: 10.5, y: 4.5, decorative: true },
    ];
    let id = 1;
    for (const o of layout) {
      this.obstacles.push({ id: id++, ...o, radius: o.kind === 'oil' ? 0.5 : 0.42 });
    }
  }

  randomFreeCell() {
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(Math.random() * this.cols) + 0.5;
      const y = Math.floor(Math.random() * this.rows) + 0.5;
      if (!this.isCellFree(x, y, 1.4)) continue;
      return { x, y };
    }
    return { x: Math.random() * this.cols, y: Math.random() * this.rows };
  }

  // Side-aware spawn for team mode: red on the left third, blue on the right.
  spawnForTeam(team) {
    const sideCols = Math.max(2, Math.floor(this.cols / 4));
    for (let i = 0; i < 200; i++) {
      let cx;
      if (team === 'red') cx = Math.floor(Math.random() * sideCols);
      else if (team === 'blue') cx = this.cols - 1 - Math.floor(Math.random() * sideCols);
      else cx = Math.floor(Math.random() * this.cols);
      const cy = Math.floor(Math.random() * this.rows);
      const x = cx + 0.5, y = cy + 0.5;
      if (!this.isCellFree(x, y, 1.4)) continue;
      return { x, y };
    }
    return this.randomFreeCell();
  }

  isCellFree(x, y, minDistSq) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy < minDistSq) return false;
    }
    for (const o of this.obstacles) {
      if (o.decorative) continue;
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < 1.0) return false;
    }
    return true;
  }

  teamCounts() {
    let red = 0, blue = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    }
    return { red, blue };
  }

  pickColorKey(team) {
    if (team === 'red') return 'red';
    if (team === 'blue') return 'blue';
    const used = new Set([...this.players.values()].map(p => p.colorKey));
    for (const c of COLOR_KEYS) if (!used.has(c)) return c;
    return COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)];
  }

  ensureTotals(userId, username) {
    const key = String(userId);
    let row = this.totals.get(key);
    if (!row) {
      row = { userId: key, username, kills: 0, deaths: 0, roundsWon: 0 };
      this.totals.set(key, row);
    } else {
      row.username = username;
    }
    return row;
  }

  // ------- commands -------
  addPlayer({ userId, username, avatarUrl, requestedTeam }) {
    const key = String(userId);
    this.ensureTotals(key, username);
    if (this.players.has(key)) {
      const existing = this.players.get(key);
      existing.username = username;
      existing.avatarUrl = avatarUrl || existing.avatarUrl;
      this.respawn(existing, 'rejoined');
      return existing;
    }
    let team = null;
    if (this.settings.mode === 'team') {
      if (requestedTeam === 'red' || requestedTeam === 'blue') {
        team = requestedTeam;
      } else {
        const { red, blue } = this.teamCounts();
        if (red < blue) team = 'red';
        else if (blue < red) team = 'blue';
        else team = Math.random() < 0.5 ? 'red' : 'blue';
      }
    }
    const colorKey = this.pickColorKey(team);
    const spot = team ? this.spawnForTeam(team) : this.randomFreeCell();
    const player = {
      userId: key,
      username,
      avatarUrl: avatarUrl || null,
      team,
      colorKey,
      color: COLOR_HEX[colorKey],
      x: spot.x, y: spot.y,
      targetX: null, targetY: null,
      facing: team === 'blue' ? Math.PI : 0, // face the enemy side in teams
      barrelAngle: team === 'blue' ? Math.PI : 0,
      hp: this.settings.startingHp,
      alive: true,
      lastShotAt: 0,
      diedAt: 0,
      respawnAt: 0,
      kills: 0, // per round
      deaths: 0,
      joinedAt: Date.now(),
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

  respawn(p, reason = 'respawned') {
    const spot = p.team ? this.spawnForTeam(p.team) : this.randomFreeCell();
    p.x = spot.x; p.y = spot.y;
    p.targetX = null; p.targetY = null;
    p.hp = this.settings.startingHp;
    p.alive = true;
    p.diedAt = 0; p.respawnAt = 0;
    p.facing = p.team === 'blue' ? Math.PI : 0;
    p.barrelAngle = p.facing;
    if (reason) this.pushEvent(`${p.username} ${reason}`);
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
    if (now - p.lastShotAt < this.settings.shotCooldownMs) return false;
    const tx = targetCellX + 0.5;
    const ty = targetCellY + 0.5;
    const dx = tx - p.x, dy = ty - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    p.barrelAngle = Math.atan2(uy, ux);
    p.lastShotAt = now;
    this.projectiles.push({
      id: projectileSeq++,
      ownerId: p.userId,
      ownerTeam: p.team,
      bulletColor: p.colorKey,
      x: p.x + ux * 0.5,
      y: p.y + uy * 0.5,
      dx: ux, dy: uy,
      bornAt: now,
    });
    this.pushEvent(`${p.username} fired → ${formatCell(targetCellX, targetCellY)}`);
    return true;
  }

  setColor(userId, hexOrKey) {
    const p = this.players.get(String(userId));
    if (!p) return false;
    if (this.settings.mode === 'team') return false; // team mode forces team color
    const key = String(hexOrKey).toLowerCase();
    if (COLOR_KEYS.includes(key)) {
      p.colorKey = key;
      p.color = COLOR_HEX[key];
      return true;
    }
    return false;
  }

  // ------- round lifecycle -------
  beginRound() {
    this.roundNumber += 1;
    this.phase = 'running';
    this.roundStartedAt = Date.now();
    this.roundEndsAt = this.roundStartedAt + this.settings.roundMs;
    this.projectiles = [];
    for (const p of this.players.values()) {
      p.kills = 0;
      this.respawn(p, null);
    }
    this.placeObstacles();
    this.pushEvent(`Round ${this.roundNumber} started`);
  }

  endRound(reason = 'time') {
    if (this.phase !== 'running') return null;
    this.phase = 'break';
    this.breakEndsAt = Date.now() + this.settings.breakMs;
    // Determine winner
    const alivePlayers = [...this.players.values()].filter(p => p.alive);
    let winner = null;
    if (this.settings.mode === 'team') {
      const score = { red: 0, blue: 0 };
      for (const p of this.players.values()) {
        if (p.team) score[p.team] += p.kills;
      }
      const winningTeam = score.red === score.blue ? null :
        (score.red > score.blue ? 'red' : 'blue');
      if (winningTeam) {
        winner = { kind: 'team', name: winningTeam, kills: score[winningTeam] };
        for (const p of this.players.values()) {
          if (p.team === winningTeam) {
            const t = this.ensureTotals(p.userId, p.username);
            t.roundsWon += 1;
          }
        }
        this.pushEvent(`Round ${this.roundNumber} → team ${winningTeam.toUpperCase()} wins (${score[winningTeam]} kills)`);
      } else {
        winner = { kind: 'draw', name: null, kills: 0 };
        this.pushEvent(`Round ${this.roundNumber} → draw`);
      }
    } else {
      const sorted = [...this.players.values()].sort((a, b) => b.kills - a.kills);
      if (sorted.length && sorted[0].kills > 0) {
        const top = sorted[0];
        winner = { kind: 'player', name: top.username, kills: top.kills };
        const t = this.ensureTotals(top.userId, top.username);
        t.roundsWon += 1;
        this.pushEvent(`Round ${this.roundNumber} → ${top.username} wins (${top.kills} kills)`);
      } else {
        winner = { kind: 'draw', name: null, kills: 0 };
        this.pushEvent(`Round ${this.roundNumber} → draw`);
      }
    }
    this.lastWinner = winner;
    return winner;
  }

  forceEndRound() {
    return this.endRound('admin');
  }

  resetScoreboard() {
    this.totals.clear();
    for (const p of this.players.values()) {
      this.ensureTotals(p.userId, p.username);
    }
    this.pushEvent('scoreboard reset');
  }

  // ------- per-tick simulation -------
  tick(now) {
    const dt = Math.min(0.25, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;

    // Round transitions
    if (this.phase === 'running' && now >= this.roundEndsAt) {
      this.endRound('time');
    } else if (this.phase === 'break' && now >= this.breakEndsAt) {
      this.beginRound();
    }
    if (this.phase !== 'running') return;

    // Move tanks
    for (const p of this.players.values()) {
      // Respawn dead tanks
      if (!p.alive) {
        if (p.respawnAt && now >= p.respawnAt) {
          this.respawn(p, 'respawned');
        }
        continue;
      }
      if (p.targetX == null) continue;
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const dist = Math.hypot(dx, dy);
      const step = this.settings.tankSpeed * dt;
      if (dist <= step) {
        p.x = p.targetX; p.y = p.targetY;
        p.targetX = null; p.targetY = null;
      } else {
        const nx = p.x + (dx / dist) * step;
        const ny = p.y + (dy / dist) * step;
        if (!this.isBlockedByObstacle(nx, ny)) {
          p.x = nx; p.y = ny;
          p.facing = Math.atan2(dy, dx);
        } else {
          // hit an obstacle — stop here
          p.targetX = null; p.targetY = null;
        }
      }
    }

    // Move projectiles + collide
    const surviving = [];
    for (const pr of this.projectiles) {
      const sp = this.settings.projectileSpeed * dt;
      pr.x += pr.dx * sp;
      pr.y += pr.dy * sp;
      if (pr.x < -0.5 || pr.x > this.cols + 0.5 || pr.y < -0.5 || pr.y > this.rows + 0.5) {
        continue; // off-map
      }
      // Obstacle hit?
      let killedByObstacle = false;
      for (const o of this.obstacles) {
        if (o.decorative) continue;
        const dx = o.x - pr.x, dy = o.y - pr.y;
        if (dx * dx + dy * dy <= (o.radius + this.settings.projectileRadius) ** 2) {
          killedByObstacle = true; break;
        }
      }
      if (killedByObstacle) continue;

      // Tank hit?
      let hit = null;
      for (const target of this.players.values()) {
        if (!target.alive) continue;
        if (target.userId === pr.ownerId) continue;
        if (this.settings.mode === 'team' && pr.ownerTeam && target.team === pr.ownerTeam) continue;
        const ddx = target.x - pr.x;
        const ddy = target.y - pr.y;
        if (ddx * ddx + ddy * ddy <= (this.settings.tankRadius + this.settings.projectileRadius) ** 2) {
          hit = target; break;
        }
      }
      if (hit) {
        hit.hp -= 1;
        const owner = this.players.get(pr.ownerId);
        if (hit.hp <= 0) {
          hit.alive = false;
          hit.deaths++;
          hit.diedAt = now;
          hit.respawnAt = now + this.settings.respawnMs;
          const tHit = this.ensureTotals(hit.userId, hit.username);
          tHit.deaths++;
          if (owner) {
            owner.kills++;
            const tOwner = this.ensureTotals(owner.userId, owner.username);
            tOwner.kills++;
          }
          this.pushEvent(`${owner ? owner.username : '???'} killed ${hit.username}`);
          this.pushFx('explosion', hit.x, hit.y);
        } else {
          this.pushEvent(`${owner ? owner.username : '???'} hit ${hit.username} (${hit.hp} HP)`);
          this.pushFx('hit', pr.x, pr.y);
        }
      } else {
        surviving.push(pr);
      }
    }
    this.projectiles = surviving;
  }

  pushFx(kind, x, y) {
    // Lightweight transient effects sent to clients via a queue.
    this._fx = this._fx || [];
    this._fx.push({ kind, x, y, t: Date.now() });
    if (this._fx.length > 100) this._fx.shift();
  }

  isBlockedByObstacle(x, y) {
    for (const o of this.obstacles) {
      if (o.decorative) continue;
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < (o.radius + this.settings.tankRadius) ** 2) return true;
    }
    return false;
  }

  // ------- serialization -------
  serialize() {
    const now = Date.now();
    const fxBatch = this._fx || [];
    this._fx = []; // drain
    return {
      cols: this.cols,
      rows: this.rows,
      settings: { ...this.settings },
      threadId: this.threadId,
      threadUrl: this.threadUrl,
      phase: this.phase,
      roundNumber: this.roundNumber,
      roundStartedAt: this.roundStartedAt,
      roundEndsAt: this.roundEndsAt,
      breakEndsAt: this.breakEndsAt,
      lastWinner: this.lastWinner,
      serverTime: now,
      commandsApplied: this.commandsApplied,
      players: [...this.players.values()].map(p => ({
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        team: p.team,
        colorKey: p.colorKey,
        color: p.color,
        x: p.x, y: p.y,
        targetX: p.targetX, targetY: p.targetY,
        facing: p.facing,
        barrelAngle: p.barrelAngle,
        hp: p.hp,
        maxHp: this.settings.startingHp,
        alive: p.alive,
        respawnAt: p.respawnAt,
        kills: p.kills, deaths: p.deaths,
      })),
      projectiles: this.projectiles.map(pr => ({
        id: pr.id, x: pr.x, y: pr.y, dx: pr.dx, dy: pr.dy,
        ownerId: pr.ownerId, bulletColor: pr.bulletColor,
      })),
      obstacles: this.obstacles.map(o => ({ id: o.id, kind: o.kind, x: o.x, y: o.y })),
      events: this.events.slice(-30),
      fx: fxBatch,
      scoreboard: [...this.totals.values()]
        .sort((a, b) => (b.kills - a.kills) || (b.roundsWon - a.roundsWon) || (a.deaths - b.deaths))
        .slice(0, 50),
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

export { COLOR_KEYS, COLOR_HEX };
