// Thin client for the lolz.live REST API.
const API_BASE = 'https://prod-api.lolz.live';

class LolzClient {
  constructor(token) {
    this.token = token;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    let url = API_BASE + path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const headers = { Authorization: `Bearer ${this.token}` };
    const init = { method, headers };
    if (body) {
      if (body instanceof URLSearchParams) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = body.toString();
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      const msg = json?.errors?.join('; ') || text.slice(0, 300);
      const err = new Error(`lolz ${method} ${path} -> ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async me() {
    const r = await this.request('/users/me');
    return r.user;
  }

  async getThread(threadId) {
    const r = await this.request(`/threads/${threadId}`);
    return r.thread;
  }

  // Get the newest N posts of a thread (skipping the OP).
  // Returns posts sorted by post_id ascending so callers can stream them.
  async getRecentPosts(threadId, { limit = 20 } = {}) {
    const r = await this.request('/posts', {
      query: { thread_id: threadId, limit, order: 'natural_reverse', page: 1 },
    });
    const posts = (r.posts || []).slice();
    posts.sort((a, b) => a.post_id - b.post_id);
    return posts;
  }

  // Get posts with id > sincePostId (newest first).
  async getPostsAfter(threadId, sincePostId, { pageSize = 20, maxPages = 5 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request('/posts', {
        query: { thread_id: threadId, limit: pageSize, order: 'natural_reverse', page },
      });
      const posts = r.posts || [];
      if (!posts.length) break;
      let stop = false;
      for (const p of posts) {
        if (p.post_id <= sincePostId) { stop = true; continue; }
        if (p.post_is_first_post) continue;
        out.push(p);
      }
      if (stop) break;
      if (posts.length < pageSize) break;
    }
    out.sort((a, b) => a.post_id - b.post_id);
    return out;
  }

  async createPost(threadId, body) {
    const form = new URLSearchParams();
    form.set('thread_id', String(threadId));
    form.set('post_body', body);
    const r = await this.request('/posts', { method: 'POST', body: form });
    return r.post;
  }

  async getUser(userId) {
    const r = await this.request(`/users/${userId}`);
    return r.user;
  }
}

export function makeLolzClient(token) {
  return new LolzClient(token);
}

// Parse "https://lolz.live/threads/9991149/" or just "9991149" -> 9991149
export function parseThreadId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/threads\/(\d+)/);
  if (m) return Number(m[1]);
  return null;
}
