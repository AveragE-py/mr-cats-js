/**
 * KittyDB JavaScript Client
 * Persistent auth + data / images / realtime API for the KittyDB backend.
 *
 * Usage:
 *   const db = new KittyDB('https://your-api.example.com');
 *   await db.login('Nick', 'TAG', 'password');
 *   // token is stored in localStorage → user stays logged in across pages
 *   const posts = await db.find('posts', { filter: ['_owner:eq:ABCDEF'], limit: 20 });
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'kittydb_session';

  class KittyDB {
    /**
     * @param {string} baseUrl  Base URL of the KittyDB server (no trailing slash)
     * @param {object} [opts]
     * @param {string} [opts.storageKey]  localStorage key (default: kittydb_session)
     * @param {boolean} [opts.autoRefresh=true]  Silently refresh token on load
     */
    constructor(baseUrl, opts = {}) {
      this.baseUrl = (baseUrl || '').replace(/\/$/, '');
      this.storageKey = opts.storageKey || STORAGE_KEY;
      this.autoRefresh = opts.autoRefresh !== false;
      this._token = null;
      this._user = null; // { nick, tag, suid? }
      this._hub = null;
      this._listeners = new Map(); // event -> Set<fn>

      this._loadSession();
      if (this.autoRefresh && this._token) {
        this.refresh().catch(() => this.logout(false));
      }
    }

    // ── Session persistence ────────────────────────────────────────────────

    _loadSession() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && data.token) {
          this._token = data.token;
          this._user = { nick: data.nick, tag: data.tag, suid: data.suid };
        }
      } catch (_) { /* ignore corrupt storage */ }
    }

    _saveSession(token, nick, tag, suid) {
      this._token = token;
      this._user = { nick, tag, suid };
      try {
        localStorage.setItem(this.storageKey, JSON.stringify({
          token, nick, tag, suid: suid || undefined,
          savedAt: Date.now()
        }));
      } catch (_) { /* quota / private mode */ }
    }

    _clearSession() {
      this._token = null;
      this._user = null;
      try { localStorage.removeItem(this.storageKey); } catch (_) {}
    }

    /** Current user or null */
    get user() { return this._user ? { ...this._user } : null; }
    get isLoggedIn() { return !!this._token; }
    get token() { return this._token; }

    // ── HTTP helpers ───────────────────────────────────────────────────────

    async _request(method, path, body, isForm = false) {
      const headers = {};
      if (this._token) headers['Authorization'] = `Bearer ${this._token}`;
      if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined),
        credentials: 'include'
      });

      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (!res.ok) {
        const err = new Error((data && data.error) || data || res.statusText || 'Request failed');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    // ── Auth ───────────────────────────────────────────────────────────────

    /**
     * Register a new account. Returns session and stores it.
     * @returns {{ token, nick, tag, suid }}
     */
    async register(nick, password) {
      const data = await this._request('POST', '/auth/register', { nick, password });
      this._saveSession(data.token, data.nick, data.tag, data.suid);
      this._emit('login', this.user);
      return data;
    }

    /**
     * Login with nick + tag + password. Token is persisted in localStorage
     * so the user stays logged in on every page of the site.
     */
    async login(nick, tag, password) {
      const data = await this._request('POST', '/auth/login', { nick, tag, password });
      this._saveSession(data.token, data.nick, data.tag);
      this._emit('login', this.user);
      return data;
    }

    /** Fetch current user profile (validates token). */
    async me() {
      const data = await this._request('GET', '/auth/me');
      if (data) {
        this._user = { nick: data.nick, tag: data.tag, suid: data.suid };
        this._saveSession(this._token, data.nick, data.tag, data.suid);
      }
      return data;
    }

    /** Extend session lifetime (called automatically on load). */
    async refresh() {
      const data = await this._request('POST', '/auth/refresh');
      this._saveSession(data.token, data.nick, data.tag);
      return data;
    }

    /**
     * Logout. Clears local session and invalidates server token.
     * @param {boolean} [server=true]  also call the server
     */
    async logout(server = true) {
      if (server && this._token) {
        try { await this._request('POST', '/auth/logout'); } catch (_) {}
      }
      this._clearSession();
      this._emit('logout');
    }

    // ── Data (collections) ─────────────────────────────────────────────────

    /**
     * Query a collection with optional filters, sort and pagination.
     *
     * Filters are strings: "field:op:value"
     * Ops: eq, ne, gt, gte, lt, lte, contains, startswith, endswith, exists
     *
     * @param {string} collection
     * @param {object} [opts]
     * @param {string|string[]} [opts.filter]
     * @param {string} [opts.owner]   shorthand for _owner:eq:TAG
     * @param {number} [opts.skip]
     * @param {number} [opts.limit]
     * @param {string} [opts.sort]
     * @param {'asc'|'desc'} [opts.order]
     */
    async find(collection, opts = {}) {
      const q = new URLSearchParams();
      if (opts.skip != null) q.set('skip', opts.skip);
      if (opts.limit != null) q.set('limit', opts.limit);
      if (opts.sort) q.set('sort', opts.sort);
      if (opts.order) q.set('order', opts.order);
      if (opts.owner) q.set('owner', opts.owner);

      const filters = Array.isArray(opts.filter) ? opts.filter
        : opts.filter ? [opts.filter] : [];
      for (const f of filters) q.append('filter', f);

      const qs = q.toString();
      return this._request('GET', `/data/${encodeURIComponent(collection)}${qs ? '?' + qs : ''}`);
    }

    /** Get a single document by id. */
    async get(collection, id) {
      return this._request('GET', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    }

    /** Insert a document. Requires login (or admin key). */
    async insert(collection, doc) {
      return this._request('POST', `/data/${encodeURIComponent(collection)}`, doc);
    }

    /** Replace a document. Owner or admin only. */
    async update(collection, id, doc) {
      return this._request('PUT', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, doc);
    }

    /** Delete a document. Owner or admin only. */
    async remove(collection, id) {
      return this._request('DELETE', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    }

    /**
     * Ensure an index on a field (logged-in or admin).
     * @param {string} collection
     * @param {string} field
     * @param {boolean} [unique=false]
     */
    async ensureIndex(collection, field, unique = false) {
      const q = new URLSearchParams({ field, unique: unique ? 'true' : 'false' });
      return this._request('POST', `/data/${encodeURIComponent(collection)}/index?${q}`);
    }

    // ── Images ─────────────────────────────────────────────────────────────

    /** List all images. */
    async listImages() {
      return this._request('GET', '/images');
    }

    /**
     * Upload an image (File or Blob). Returns { id, url }.
     * @param {File|Blob} file
     * @param {string} [filename]
     */
    async uploadImage(file, filename) {
      const form = new FormData();
      form.append('file', file, filename || (file.name || 'image.png'));
      return this._request('POST', '/images', form, true);
    }

    /** Absolute URL for an image id. */
    imageUrl(id) {
      return `${this.baseUrl}/images/${encodeURIComponent(id)}`;
    }

    /** Delete an image (owner or admin). */
    async deleteImage(id) {
      return this._request('DELETE', `/images/${encodeURIComponent(id)}`);
    }

    // ── Realtime (SignalR) ─────────────────────────────────────────────────

    /**
     * Connect to the SignalR hub (requires @microsoft/signalr on the page
     * or a global signalR). Returns the connection.
     */
    async connectHub() {
      if (typeof signalR === 'undefined') {
        throw new Error('SignalR client not found. Include @microsoft/signalr before kittydb.js');
      }
      if (this._hub && this._hub.state === signalR.HubConnectionState.Connected) {
        return this._hub;
      }
      this._hub = new signalR.HubConnectionBuilder()
        .withUrl(this.baseUrl + '/hub', {
          accessTokenFactory: () => this._token || ''
        })
        .withAutomaticReconnect()
        .build();

      this._hub.on('changed', (payload) => {
        this._emit('changed', payload);
        this._emit(`changed:${payload.collection}`, payload);
      });
      this._hub.on('imageAdded', (payload) => this._emit('imageAdded', payload));
      this._hub.on('imageDeleted', (payload) => this._emit('imageDeleted', payload));

      await this._hub.start();
      return this._hub;
    }

    async subscribe(collection) {
      const hub = await this.connectHub();
      await hub.invoke('Subscribe', collection);
    }

    async unsubscribe(collection) {
      if (!this._hub) return;
      await this._hub.invoke('Unsubscribe', collection);
    }

    async subscribeImages() {
      const hub = await this.connectHub();
      await hub.invoke('SubscribeImages');
    }

    // ── Events ─────────────────────────────────────────────────────────────

    on(event, fn) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(fn);
      return () => this.off(event, fn);
    }

    off(event, fn) {
      const set = this._listeners.get(event);
      if (set) set.delete(fn);
    }

    _emit(event, data) {
      const set = this._listeners.get(event);
      if (set) for (const fn of set) {
        try { fn(data); } catch (e) { console.error('[KittyDB]', e); }
      }
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KittyDB;
  } else {
    global.KittyDB = KittyDB;
  }
})(typeof window !== 'undefined' ? window : globalThis);
