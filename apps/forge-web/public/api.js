/* Forge API wrapper: JSON-RPC over fetch + events over WebSocket. */
'use strict';

class ForgeApi {
  constructor(base, token) {
    this.base = base.replace(/\/$/, '');
    this.token = token || null;
    this._id = 1;
  }

  setToken(token) {
    this.token = token || null;
  }

  async rpc(method, params) {
    const res = await fetch(this.base + '/rpc', {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        this.token ? { authorization: 'Bearer ' + this.token } : {},
      ),
      body: JSON.stringify({ jsonrpc: '2.0', id: this._id++, method, params: params || {} }),
    });
    if (res.status === 401) throw new Error('Unauthorized — set the server token in Settings.');
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message || 'RPC error');
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }
    return json.result;
  }

  async health() {
    const res = await fetch(this.base + '/health', {
      headers: this.token ? { authorization: 'Bearer ' + this.token } : {},
    });
    if (!res.ok) throw new Error('health check failed: HTTP ' + res.status);
    return res.json();
  }

  connectEvents(filter, handlers) {
    const proto = this.base.startsWith('https') ? 'wss' : 'ws';
    const host = this.base.replace(/^https?:\/\//, '');
    const url = proto + '://' + host + '/ws' + (this.token ? '?token=' + encodeURIComponent(this.token) : '');
    const ws = new WebSocket(url);
    let alive = true;
    ws.onopen = () => {
      handlers.onStatus && handlers.onStatus('connected');
      ws.send(JSON.stringify({ type: 'subscribe', filter: filter || {} }));
      if (handlers.sinceSeq !== undefined) ws.send(JSON.stringify({ type: 'replay', sinceSeq: handlers.sinceSeq }));
    };
    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data));
        if (parsed.method === 'event' && parsed.params && handlers.onEvent) handlers.onEvent(parsed.params);
      } catch (e) { /* ignore malformed frames */ }
    };
    ws.onclose = () => { if (alive) handlers.onStatus && handlers.onStatus('disconnected'); };
    ws.onerror = () => handlers.onStatus && handlers.onStatus('error');
    return {
      disconnect() {
        alive = false;
        try { ws.close(); } catch (e) { /* ignore */ }
      },
    };
  }
}

window.ForgeApi = ForgeApi;
