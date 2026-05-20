import { extractCommands } from './commands.js';

const POLL_INTERVAL_MS = 3500;

// Polls the lolz thread linked to the perpetual Match and applies any new
// commands. Designed for a single perpetual Match instance, but kept simple
// so it can be replaced later if needed.
export class Poller {
  constructor({ lolz, match, log }) {
    this.lolz = lolz;
    this.match = match;
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
      if (!this.match.threadId) return;
      await this.pollMatch();
    } catch (e) {
      this.log(`poll failed: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async pollMatch() {
    let posts;
    if (this.match.lastPostId === 0) {
      // First poll on a freshly attached thread: snap cursor to latest post,
      // skip history.
      posts = await this.lolz.getRecentPosts(this.match.threadId, { limit: 1 });
      if (posts.length) this.match.lastPostId = posts[posts.length - 1].post_id;
      return;
    }
    posts = await this.lolz.getPostsAfter(this.match.threadId, this.match.lastPostId, { pageSize: 20, maxPages: 3 });
    if (!posts.length) return;
    for (const post of posts) {
      const text = post.post_body_plain_text || post.post_body || '';
      const cmds = extractCommands(text, { cols: this.match.cols, rows: this.match.rows });
      for (const cmd of cmds) {
        try { await this.applyCommand(post, cmd); }
        catch (e) { this.log(`applyCommand error: ${e.message}`); }
      }
      if (post.post_id > this.match.lastPostId) this.match.lastPostId = post.post_id;
    }
  }

  async applyCommand(post, cmd) {
    const userId = post.poster_user_id;
    const username = post.poster_username;
    const avatarUrl = post.links?.poster_avatar || null;
    const now = Date.now();
    this.match.commandsApplied++;
    switch (cmd.type) {
      case 'join': {
        this.match.addPlayer({ userId, username, avatarUrl, requestedTeam: cmd.team });
        break;
      }
      case 'leave': {
        this.match.removePlayer(userId, 'left');
        break;
      }
      case 'goto': {
        // Auto-join if the player isn't on the field yet.
        if (!this.match.players.has(String(userId))) {
          this.match.addPlayer({ userId, username, avatarUrl });
        }
        this.match.setTarget(userId, cmd.col, cmd.row);
        break;
      }
      case 'shot': {
        if (!this.match.players.has(String(userId))) {
          this.match.addPlayer({ userId, username, avatarUrl });
        }
        this.match.fire(userId, cmd.col, cmd.row, now);
        break;
      }
      case 'color': {
        this.match.setColor(userId, cmd.color);
        break;
      }
    }
  }
}
