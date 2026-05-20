# Tankz — live forum tank battle

A real-time 2D tank game controlled by posts in a [lolz.live](https://lolz.live) forum thread.

- Admin (the host) creates a game tied to a specific lolz.live thread.
- Players post commands in that thread; their tanks appear on a live game page with their nickname and avatar.
- Spectators watch the battle live over WebSocket.

## Commands (post in the thread)

| Command | Description |
| --- | --- |
| `!join` | Spawn your tank. In team mode you can pick a side: `!join red` / `!join blue`. Without a side the server balances teams (odd players go random). |
| `!goto B8` | Drive to grid cell B8. |
| `!shot A1` | Fire a projectile toward cell A1. |
| `!leave` | Remove your tank. |
| `!color RRGGBB` | (classic mode only) pick a hex colour for your tank. |

The grid is 16 columns (A..P) × 10 rows (1..10). Each tank has 3 HP; the last tank (or team) standing wins.

## Game modes

- **Classic** — every tank for themselves.
- **Teams** — red vs blue. Friendly fire is disabled. Last team alive wins.

## Running locally

```bash
npm install
PORT=3000 \
ADMIN_PASSWORD=set-something \
LOLZ_API_TOKEN=your_lolz_jwt \
PUBLIC_BASE_URL=http://localhost:3000 \
npm start
```

Open <http://localhost:3000> in a browser. Sign in with the admin password, point a new game at a lolz thread URL or ID, and watch tanks appear as commands roll in.

## Deploying on Render

The included `render.yaml` blueprint provisions a single web service. Environment variables to set:

- `ADMIN_PASSWORD` — password for the admin login.
- `LOLZ_API_TOKEN` — lolz.live OAuth token with `read` and `post` scopes.
- `PUBLIC_BASE_URL` — public URL of the deployed service (used in the auto-announce post inside the thread).
