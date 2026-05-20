async function refreshAdminStatus() {
  const r = await fetch('/api/admin/status');
  const data = await r.json();
  const loginForm = document.getElementById('admin-login-form');
  const createForm = document.getElementById('create-game-form');
  const pill = document.getElementById('admin-status');
  if (data.admin) {
    pill.textContent = 'Signed in';
    pill.className = 'pill live';
    loginForm.hidden = true;
    createForm.hidden = false;
  } else {
    pill.textContent = 'Signed out';
    pill.className = 'pill';
    loginForm.hidden = false;
    createForm.hidden = true;
  }
}

async function refreshGames() {
  const r = await fetch('/api/games');
  const { games } = await r.json();
  const list = document.getElementById('games-list');
  const empty = document.getElementById('no-games');
  list.innerHTML = '';
  if (!games.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const g of games) {
    const li = document.createElement('li');
    const status = g.status[0].toUpperCase() + g.status.slice(1);
    const winner = g.winnerText ? ` — ${g.winnerText}` : '';
    li.innerHTML = `<a href="/game/${g.id}">
      <span>
        <strong>${g.id}</strong>
        <small> — ${g.mode === 'team' ? 'Teams' : 'Classic'} — ${g.players} players — ${status}${winner}</small>
      </span>
      <span class="pill ${g.status}">${status}</span>
    </a>`;
    list.appendChild(li);
  }
}

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = e.target.password.value;
  const errEl = document.getElementById('admin-login-error');
  errEl.hidden = true;
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    errEl.textContent = (await r.json()).error || 'Login failed';
    errEl.hidden = false;
    return;
  }
  await refreshAdminStatus();
});

document.getElementById('admin-logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  await refreshAdminStatus();
});

document.getElementById('create-game-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('create-game-error');
  errEl.hidden = true;
  const r = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: fd.get('mode'),
      thread: fd.get('thread'),
      announce: fd.get('announce') === 'on',
    }),
  });
  if (!r.ok) {
    errEl.textContent = (await r.json()).error || 'Failed to create game';
    errEl.hidden = false;
    return;
  }
  const data = await r.json();
  window.location.href = `/game/${data.game.id}`;
});

document.getElementById('refresh-games').addEventListener('click', refreshGames);

refreshAdminStatus();
refreshGames();
setInterval(refreshGames, 4000);
