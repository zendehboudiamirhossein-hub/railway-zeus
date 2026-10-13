/**
 * Cloudflare Workers global-object shims for Node.js:
 *   - Response: allow `new Response(null, { status: 101, webSocket })` (WS accept)
 *   - WebSocketPair + CF-style WebSocket (server side) backed by the `ws` lib at runtime
 *   - caches.default / caches.open (simple in-memory cache)
 *   - execution context factory (ctx.waitUntil)
 */

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function createWsShim() {
  let realWs = null;
  let state = WS_CONNECTING;
  let accepted = false;
  let binaryType = "blob";
  let closeQueued = null;
  const listeners = { open: [], message: [], close: [], error: [] };
  const sendQueue = [];
  let queuedBytes = 0;

  const dispatch = (type, event) => {
    const ls = listeners[type];
    if (!ls || !ls.length) return;
    for (const fn of ls) {
      try { fn(event); } catch (e) { console.error("[ws-shim] listener error:", e && e.message); }
    }
  };

  const shim = {
    __isCfWsShim: true,
    accept() {
      accepted = true;
      if (state === WS_CONNECTING) state = WS_OPEN;
    },
    get readyState() { return realWs ? realWs.readyState : state; },
    get bufferedAmount() { return ((realWs && realWs.bufferedAmount) || 0) + queuedBytes; },
    get binaryType() { return binaryType; },
    set binaryType(v) {
      binaryType = v === "arraybuffer" ? "arraybuffer" : "blob";
      if (realWs) {
        try { realWs.binaryType = binaryType === "arraybuffer" ? "arraybuffer" : "nodebuffer"; } catch { }
      }
    },
    get url() { return realWs && realWs.url ? realWs.url : ""; },
    get protocol() { return realWs ? realWs.protocol || "" : ""; },
    get extensions() { return realWs ? realWs.extensions || "" : ""; },
    addEventListener(type, fn) {
      if (!listeners[type]) return;
      if (typeof fn === "function") listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    send(data) {
      if (realWs) {
        if (realWs.readyState !== WS_OPEN) return;
        try { realWs.send(data); } catch (e) { console.error("[ws-shim] send error:", e && e.message); }
        return;
      }
      if (state === WS_CLOSED || state === WS_CLOSING) return;
      const size = data && data.byteLength != null ? data.byteLength : data && data.length ? data.length : 0;
      queuedBytes += size;
      sendQueue.push(data);
    },
    close(code = 1000, reason = "") {
      if (realWs) {
        try { realWs.close(code, reason); } catch { }
        return;
      }
      if (state === WS_OPEN || accepted) {
        state = WS_CLOSING;
        closeQueued = { code, reason };
      } else if (state === WS_CONNECTING) {
        state = WS_CLOSED;
      }
    },
    __bind(ws) {
      if (realWs) return;
      realWs = ws;
      try { ws.binaryType = binaryType === "arraybuffer" ? "arraybuffer" : "nodebuffer"; } catch { }
      if (state === WS_CLOSED) {
        try { ws.terminate(); } catch { }
        return;
      }
      state = WS_OPEN;
      if (closeQueued) {
        const q = closeQueued;
        closeQueued = null;
        try { ws.close(q.code, q.reason); } catch { }
      }
      ws.on("message", (data, isBinary) => {
        if (state === WS_CLOSED) return;
        let payload;
        if (isBinary) {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (binaryType === "arraybuffer") {
            payload = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          } else {
            payload = new Uint8Array(buf);
          }
        } else {
          payload = typeof data === "string" ? data : data.toString("utf8");
        }
        dispatch("message", { type: "message", data: payload });
      });
      ws.on("close", (code, reason) => {
        state = WS_CLOSED;
        dispatch("close", { type: "close", code: code || 1005, reason: reason ? String(reason) : "", wasClean: true });
      });
      ws.on("error", (err) => {
        dispatch("error", { type: "error", error: err, message: err && err.message });
      });
      while (sendQueue.length) {
        const d = sendQueue.shift();
        try { ws.send(d); } catch (e) { console.error("[ws-shim] queued send error:", e && e.message); }
      }
      queuedBytes = 0;
      if (listeners.open.length) dispatch("open", { type: "open" });
    },
  };
  return shim;
}

class WebSocketPair {
  constructor() {
    const client = createWsShim();
    const server = createWsShim();
    client.__pair = server;
    server.__pair = client;
    // Object.values() must return [client, server] — integer-like keys keep insertion order
    this["0"] = client;
    this["1"] = server;
  }
}

let patched = false;

export function patchGlobals() {
  if (patched) return;
  patched = true;

  // --- Response: permit 101 + webSocket (Cloudflare WS accept pattern) ---
  const RealResponse = globalThis.Response;
  class CFResponse extends RealResponse {
    constructor(body, init) {
      if (init && typeof init === "object" && Number(init.status) === 101) {
        super(null, { ...init, status: 200 });
        Object.defineProperty(this, "status", { value: 101, configurable: true, writable: true });
        Object.defineProperty(this, "webSocket", { value: init.webSocket, configurable: true, writable: true });
        Object.defineProperty(this, "__cfWsAccept", { value: true, configurable: true, writable: true });
      } else {
        super(body, init);
      }
    }
  }
  globalThis.Response = CFResponse;

  globalThis.WebSocketPair = WebSocketPair;

  // --- caches.default / caches.open ---
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const keyOf = (request) => {
    if (typeof request === "string") return request;
    if (request && request.url) return request.url;
    return String(request);
  };
  const makeCache = (store) => ({
    async match(request) {
      const key = keyOf(request);
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires && Date.now() > hit.expires) {
        store.delete(key);
        return undefined;
      }
      const body = hit.body && hit.body.length ? Buffer.from(hit.body) : null;
      return new Response(body, { status: hit.status || 200, headers: new Headers(hit.headers || {}) });
    },
    async put(request, response) {
      const key = keyOf(request);
      let ttl = 0;
      try {
        const cc = response.headers.get("cache-control") || "";
        const m = /max-age=(\d+)/i.exec(cc);
        if (m) ttl = parseInt(m[1], 10) * 1000;
      } catch { }
      let body = null;
      try { body = Buffer.from(await response.arrayBuffer()); } catch { body = null; }
      const headers = {};
      try { response.headers.forEach((v, k) => { headers[k] = v; }); } catch { }
      store.set(key, { body, status: response.status, headers, expires: ttl ? Date.now() + ttl : 0 });
    },
    async delete(request) {
      return store.delete(keyOf(request));
    },
  });
  globalThis.caches = {
    default: makeCache(getStore("default")),
    open: async (name) => makeCache(getStore(String(name))),
  };
}

export function makeExecContext() {
  return {
    waitUntil(promise) {
      if (promise && typeof promise.catch === "function") {
        promise.catch((e) => {
          const msg = e && e.message ? e.message : String(e);
          if (!/timeout|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE/i.test(msg)) {
            console.error("[waitUntil]", msg);
          }
        });
      }
    },
    passThroughOnException() { },
  };
}
