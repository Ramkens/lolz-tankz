// Live game viewer. Receives game-state snapshots over Socket.IO and
// renders the field, tanks and projectiles on a canvas.
(function () {
  const path = window.location.pathname;
  const m = path.match(/^\/game\/([^/]+)/);
  if (!m) {
    document.body.innerHTML = '<div style="padding:40px;color:#eee">Open a specific game like /game/abc123</div>';
    return;
  }
  const gameId = m[1];

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const playersList = document.getElementById('players-list');
  const eventsList = document.getElementById('events-list');
  const winnerOverlay = document.getElementById('winner-overlay');
  const modeEl = document.getElementById('game-mode');
  const statusEl = document.getElementById('game-status');
  const threadLink = document.getElementById('thread-link');
  const adminControls = document.getElementById('admin-controls');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');

  let state = null;
  const avatarCache = new Map();

  function loadAvatar(url) {
    if (!url) return null;
    if (avatarCache.has(url)) return avatarCache.get(url);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => { img.ready = true; };
    img.onerror = () => { img.failed = true; };
    avatarCache.set(url, img);
    return img;
  }

  function resizeCanvas() {
    if (!state) return;
    const margin = { left: 30, top: 24, right: 12, bottom: 12 };
    const wrap = canvas.parentElement.getBoundingClientRect();
    const maxW = Math.max(320, wrap.width - 16);
    const cellByW = (maxW - margin.left - margin.right) / state.cols;
    const cell = Math.max(28, Math.min(60, Math.floor(cellByW)));
    canvas.width = margin.left + margin.right + cell * state.cols;
    canvas.height = margin.top + margin.bottom + cell * state.rows;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.dataset.cell = String(cell);
    canvas.dataset.left = String(margin.left);
    canvas.dataset.top = String(margin.top);
  }

  function cellLabel(col) {
    let label = '';
    let n = col + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      label = String.fromCharCode(65 + r) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  function draw() {
    if (!state) return;
    const cell = Number(canvas.dataset.cell) || 40;
    const ox = Number(canvas.dataset.left) || 30;
    const oy = Number(canvas.dataset.top) || 24;

    ctx.fillStyle = '#0a0f24';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= state.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * cell, oy);
      ctx.lineTo(ox + c * cell, oy + state.rows * cell);
      ctx.stroke();
    }
    for (let r = 0; r <= state.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cell);
      ctx.lineTo(ox + state.cols * cell, oy + r * cell);
      ctx.stroke();
    }

    // alternating squares for readability
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (((r + c) & 1) === 0) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
      }
    }

    // labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < state.cols; c++) {
      ctx.fillText(cellLabel(c), ox + c * cell + cell / 2, oy - 12);
    }
    ctx.textAlign = 'right';
    for (let r = 0; r < state.rows; r++) {
      ctx.fillText(String(r + 1), ox - 8, oy + r * cell + cell / 2);
    }

    // projectiles
    for (const pr of state.projectiles) {
      const px = ox + pr.x * cell;
      const py = oy + pr.y * cell;
      ctx.beginPath();
      ctx.fillStyle = '#fde047';
      ctx.arc(px, py, Math.max(3, cell * 0.12), 0, Math.PI * 2);
      ctx.fill();
      // trail
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(253,224,71,0.5)';
      ctx.lineWidth = 2;
      ctx.moveTo(px, py);
      ctx.lineTo(px - pr.dx * cell * 0.6, py - pr.dy * cell * 0.6);
      ctx.stroke();
    }

    // tanks
    for (const p of state.players) {
      drawTank(p, ox, oy, cell);
    }
  }

  function drawTank(p, ox, oy, cell) {
    const cx = ox + p.x * cell;
    const cy = oy + p.y * cell;
    const size = cell * 0.72;

    if (!p.alive) ctx.globalAlpha = 0.35;

    // target marker
    if (p.alive && p.targetX != null) {
      ctx.save();
      ctx.strokeStyle = p.color + 'aa';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ox + p.targetX * cell, oy + p.targetY * cell);
      ctx.stroke();
      ctx.restore();
    }

    // body (rounded square)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.facing || 0);

    // base
    ctx.fillStyle = p.color;
    roundRect(ctx, -size / 2, -size * 0.35, size, size * 0.7, Math.max(3, size * 0.12));
    ctx.fill();
    // tracks
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-size / 2, -size * 0.46, size, size * 0.12);
    ctx.fillRect(-size / 2, size * 0.34, size, size * 0.12);
    // turret
    ctx.beginPath();
    ctx.fillStyle = shade(p.color, -25);
    ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2);
    ctx.fill();
    // cannon
    ctx.fillStyle = '#0a0f24';
    ctx.fillRect(size * 0.05, -size * 0.07, size * 0.5, size * 0.14);
    // team accent
    if (p.team) {
      ctx.fillStyle = p.team === 'red' ? '#fecaca' : '#bfdbfe';
      ctx.fillRect(-size * 0.1, -size * 0.05, size * 0.2, size * 0.1);
    }
    ctx.restore();

    // avatar above the tank
    const avatarSize = Math.max(18, cell * 0.55);
    const avatarY = cy - size * 0.85 - avatarSize * 0.5;
    const img = p.avatarUrl ? loadAvatar(p.avatarUrl) : null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, avatarY, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#1a2240';
    ctx.fill();
    if (img && img.ready) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, avatarY, avatarSize / 2 - 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - avatarSize / 2, avatarY - avatarSize / 2, avatarSize, avatarSize);
      ctx.restore();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.color;
    ctx.stroke();
    ctx.restore();

    // username
    ctx.fillStyle = '#e9ecf7';
    ctx.font = `600 ${Math.max(11, Math.floor(cell * 0.28))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const nameY = avatarY - avatarSize / 2 - 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeText(p.username, cx, nameY);
    ctx.fillText(p.username, cx, nameY);

    // hp bar
    const hpBarW = size;
    const hpBarH = Math.max(3, cell * 0.06);
    const hpY = cy + size * 0.55;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(cx - hpBarW / 2, hpY, hpBarW, hpBarH);
    const maxHp = 3;
    const ratio = Math.max(0, Math.min(1, p.hp / maxHp));
    ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.2 ? '#facc15' : '#ef4444';
    ctx.fillRect(cx - hpBarW / 2, hpY, hpBarW * ratio, hpBarH);

    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function shade(hex, percent) {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    r = Math.max(0, Math.min(255, r + Math.round(255 * (percent / 100))));
    g = Math.max(0, Math.min(255, g + Math.round(255 * (percent / 100))));
    b = Math.max(0, Math.min(255, b + Math.round(255 * (percent / 100))));
    return `rgb(${r},${g},${b})`;
  }

  function updateUI() {
    modeEl.textContent = state.mode === 'team' ? 'Teams' : 'Classic';
    statusEl.textContent = state.status[0].toUpperCase() + state.status.slice(1);
    statusEl.className = 'pill ' + state.status;
    if (state.threadUrl) {
      threadLink.href = state.threadUrl;
      threadLink.hidden = false;
    } else {
      threadLink.hidden = true;
    }
    playersList.innerHTML = '';
    const sorted = state.players.slice().sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    for (const p of sorted) {
      const li = document.createElement('li');
      const teamLabel = p.team ? ` <span class="pill">${p.team}</span>` : '';
      li.innerHTML = `<img alt="" src="${p.avatarUrl || ''}" onerror="this.style.opacity=0.2" />
        <div>
          <div class="name${p.alive ? '' : ' dead'}" style="color:${p.color}">${escapeHtml(p.username)}${teamLabel}</div>
          <div class="meta">K ${p.kills} · D ${p.deaths}</div>
        </div>
        <div class="hp">${p.hp} HP</div>`;
      playersList.appendChild(li);
    }
    eventsList.innerHTML = '';
    for (const ev of state.events.slice().reverse()) {
      const li = document.createElement('li');
      li.textContent = ev.text;
      eventsList.appendChild(li);
    }
    if (state.status === 'finished' && state.winnerText) {
      winnerOverlay.hidden = false;
      winnerOverlay.textContent = state.winnerText;
    } else {
      winnerOverlay.hidden = true;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Admin controls
  fetch('/api/admin/status').then(r => r.json()).then(d => {
    if (d.admin) adminControls.hidden = false;
  });
  startBtn?.addEventListener('click', async () => {
    await fetch(`/api/games/${gameId}/start`, { method: 'POST' });
  });
  stopBtn?.addEventListener('click', async () => {
    await fetch(`/api/games/${gameId}/stop`, { method: 'POST' });
  });

  // Socket
  const socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => socket.emit('join-game', gameId));
  socket.on('game-state', (s) => {
    const firstFrame = !state;
    state = s;
    if (firstFrame) resizeCanvas();
    updateUI();
    draw();
  });
  socket.on('game-error', (e) => {
    document.querySelector('main').innerHTML =
      `<div class="card" style="margin:40px">Game not found (${escapeHtml(e.error)}). <a href="/">Back</a></div>`;
  });

  window.addEventListener('resize', () => {
    resizeCanvas();
    draw();
  });

  // Render loop independent of network updates for smooth visuals.
  let lastDraw = 0;
  function loop(t) {
    if (state && t - lastDraw > 33) {
      draw();
      lastDraw = t;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
