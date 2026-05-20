import { extractCommands } from './commands.js';

const POLL_INTERVAL_MS = 3500;

export class Poller {
  constructor({ lolz, games, log }) {
    this.lolz = lolz;
    this.games = games; // Map<id, Game>
    this.log = log || (() => {});
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => this.log('poller error', e)), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const game of this.games.values()) {
        if (game.status === 'finished') continue;
        if (!game.threadId) continue;
        try {
          await this.pollGame(game);
        } catch (e) {
          this.log(`poll game ${game.id} failed: ${e.message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async pollGame(game) {
    let posts;
    if (game.lastPostId === 0) {
      // First poll: capture the latest existing post_id without acting on history.
      posts = await this.lolz.getRecentPosts(game.threadId, { limit: 1 });
      if (posts.length) game.lastPostId = posts[posts.length - 1].post_id;
      return;
    }
    posts = await this.lolz.getPostsAfter(game.threadId, game.lastPostId, { pageSize: 20, maxPages: 3 });
    if (!posts.length) return;
    for (const post of posts) {
      const text = post.post_body_plain_text || post.post_body || '';
      const cmds = extractCommands(text, { cols: game.cols, rows: game.rows });
      for (const cmd of cmds) {
        await this.applyCommand(game, post, cmd);
      }
      if (post.post_id > game.lastPostId) game.lastPostId = post.post_id;
    }
  }

  async applyCommand(game, post, cmd) {
    const userId = post.poster_user_id;
    const username = post.poster_username;
    const avatarUrl = post.links?.poster_avatar || null;
    const now = Date.now();
    game.commandsApplied++;
    switch (cmd.type) {
      case 'join': {
        if (game.status === 'finished') return;
        game.addPlayer({ userId, username, avatarUrl, requestedTeam: cmd.team });
        break;
      }
      case 'leave': {
        game.removePlayer(userId, 'left');
        break;
      }
      case 'goto': {
        if (game.status !== 'running') return;
        if (!game.players.has(String(userId))) {
          game.addPlayer({ userId, username, avatarUrl });
        }
        game.setTarget(userId, cmd.col, cmd.row);
        break;
      }
      case 'shot': {
        if (game.status !== 'running') return;
        if (!game.players.has(String(userId))) {
          game.addPlayer({ userId, username, avatarUrl });
        }
        game.fire(userId, cmd.col, cmd.row, now);
        break;
      }
      case 'color': {
        const p = game.players.get(String(userId));
        if (p && game.mode === 'classic') p.color = cmd.color;
        break;
      }
    }
  }
}
