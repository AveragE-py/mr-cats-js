(function (global) {
  'use strict';

  const STORAGE_KEY = 'kittydb_session';

  class KittyDB {
    constructor(baseUrl, opts = {}) {
      this.baseUrl = (baseUrl || '').replace(/\/$/, '');
      this.storageKey = opts.storageKey || STORAGE_KEY;
      this.autoRefresh = opts.autoRefresh !== false;
      this._token = null;
      this._user = null;
      this._hub = null;
      this._listeners = new Map();

      this._loadSession();
      if (this.autoRefresh && this._token) {
        this.refresh().catch(() => this.logout(false));
      }
    }


    _loadSession() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && data.token) {
          this._token = data.token;
          this._user = { nick: data.nick, tag: data.tag, suid: data.suid };
        }
      } catch (_) {}
    }

    _saveSession(token, nick, tag, suid) {
      this._token = token;
      this._user = { nick, tag, suid };
      try {
        localStorage.setItem(this.storageKey, JSON.stringify({
          token, nick, tag, suid: suid || undefined,
          savedAt: Date.now()
        }));
      } catch (_) {}
    }

    _clearSession() {
      this._token = null;
      this._user = null;
      try { localStorage.removeItem(this.storageKey); } catch (_) {}
    }

    get user() { return this._user ? { ...this._user } : null; }
    get isLoggedIn() { return !!this._token; }
    get token() { return this._token; }


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

    async register(nick, password) {
      const data = await this._request('POST', '/auth/register', { nick, password });
      this._saveSession(data.token, data.nick, data.tag, data.suid);
      this._emit('login', this.user);
      return data;
    }

    async login(nick, tag, password) {
      const data = await this._request('POST', '/auth/login', { nick, tag, password });
      this._saveSession(data.token, data.nick, data.tag);
      this._emit('login', this.user);
      return data;
    }

    async me() {
      const data = await this._request('GET', '/auth/me');
      if (data) {
        this._user = { nick: data.nick, tag: data.tag, suid: data.suid };
        this._saveSession(this._token, data.nick, data.tag, data.suid);
      }
      return data;
    }

    async refresh() {
      const data = await this._request('POST', '/auth/refresh');
      this._saveSession(data.token, data.nick, data.tag);
      return data;
    }

    async logout(server = true) {
      if (server && this._token) {
        try { await this._request('POST', '/auth/logout'); } catch (_) {}
      }
      this._clearSession();
      this._emit('logout');
    }
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

    async get(collection, id) {
      return this._request('GET', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    }

    async insert(collection, doc) {
      return this._request('POST', `/data/${encodeURIComponent(collection)}`, doc);
    }

    async update(collection, id, doc) {
      return this._request('PUT', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, doc);
    }

    async remove(collection, id) {
      return this._request('DELETE', `/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    }

    async ensureIndex(collection, field, unique = false) {
      const q = new URLSearchParams({ field, unique: unique ? 'true' : 'false' });
      return this._request('POST', `/data/${encodeURIComponent(collection)}/index?${q}`);
    }

    async listImages() {
      return this._request('GET', '/images');
    }

    async uploadImage(file, filename) {
      const form = new FormData();
      form.append('file', file, filename || (file.name || 'image.png'));
      return this._request('POST', '/images', form, true);
    }

    imageUrl(id) {
      return `${this.baseUrl}/images/${encodeURIComponent(id)}`;
    }

    async deleteImage(id) {
      return this._request('DELETE', `/images/${encodeURIComponent(id)}`);
    }

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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KittyDB;
  } else {
    global.KittyDB = KittyDB;
  }
})(typeof window !== 'undefined' ? window : globalThis);
