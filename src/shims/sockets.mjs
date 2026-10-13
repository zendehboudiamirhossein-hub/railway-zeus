/**
 * Cloudflare `cloudflare:sockets` -> Node.js (net/tls) compatibility shim.
 *
 * Implements the subset of the Cloudflare TCPSocket API used by the panel:
 *   - connect({ hostname, port } | "host:port", { secureTransport? })
 *   - socket.opened  : Promise (resolves when TCP/TLS established)
 *   - socket.closed  : Promise (resolves when fully closed)
 *   - socket.readable: byte-backed ReadableStream (supports BYOB readers)
 *   - socket.writable: WritableStream
 *   - socket.close() : Promise
 */
import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";

const READ_PAUSE_AT = 4 * 1024 * 1024; // pause socket when 4MB unconsumed
const READ_RESUME_AT = 1 * 1024 * 1024; // resume once drained below 1MB
const AUTO_CHUNK = 64 * 1024;

function stripBrackets(host) {
  if (typeof host !== "string") return host;
  if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
  return host;
}

function toPlainU8(chunk) {
  // Always hand the worker a clean Uint8Array copy so .buffer/.slice semantics match CF.
  if (chunk instanceof Uint8Array && !(chunk instanceof Buffer)) return chunk;
  const u8 = new Uint8Array(chunk.byteLength);
  u8.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return u8;
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(chunk);
}

function parseAddress(address) {
  let hostname = "";
  let port = 0;
  let secure = false;
  if (typeof address === "string") {
    const bracket = address.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracket) {
      hostname = bracket[1];
      port = Number(bracket[2]);
    } else {
      const m = address.match(/^(.+):(\d+)$/);
      hostname = m ? m[1] : address;
      port = m ? Number(m[2]) : 0;
    }
  } else if (address && typeof address === "object") {
    hostname = address.hostname != null ? String(address.hostname) : "";
    port = Number(address.port) || 0;
    const st = address.secureTransport != null ? address.secureTransport : address.options?.secureTransport;
    secure = st === "on";
  }
  return { hostname: stripBrackets(hostname), port, secure };
}

class TCPSocket {
  constructor(address, options = {}) {
    const { hostname, port, secure } = parseAddress(address);
    const opts = typeof options === "object" && options !== null ? options : {};
    const st = opts.secureTransport != null ? opts.secureTransport : address?.secureTransport;
    const useTls = secure || st === "on";

    const sock = useTls
      ? tls.connect({ host: hostname, port, servername: hostname || undefined })
      : net.connect({ host: hostname, port });
    sock.setNoDelay(true);
    this.__sock = sock;
    this.__address = { hostname, port };

    let openedResolve;
    let openedReject;
    let closedResolve;
    this.opened = new Promise((res, rej) => { openedResolve = res; openedReject = rej; });
    this.closed = new Promise((res) => { closedResolve = res; });

    // ---- readable stream state ----
    const queue = [];
    let queuedBytes = 0;
    let pendingPull = null; // { resolve, controller }
    let ended = false;
    let errored = null;
    let controllerRef = null;

    const tryResume = () => {
      if (queuedBytes < READ_RESUME_AT) {
        try { sock.resume(); } catch { }
      }
    };

    const finishEnded = () => {
      if (pendingPull && queue.length === 0) {
        const p = pendingPull;
        pendingPull = null;
        try { p.controller.close(); } catch { }
        p.resolve();
      }
    };

    const onChunk = (chunk) => {
      if (ended || errored) return;
      try {
        if (pendingPull) {
          const p = pendingPull;
          pendingPull = null;
          try { p.controller.enqueue(toPlainU8(chunk)); } catch { }
          p.resolve();
          tryResume();
        } else {
          queue.push(chunk);
          queuedBytes += chunk.length;
          if (queuedBytes >= READ_PAUSE_AT) {
            try { sock.pause(); } catch { }
          }
        }
      } catch { }
    };

    const onError = (err) => {
      errored = errored || err;
      if (pendingPull) {
        const p = pendingPull;
        pendingPull = null;
        try { p.controller.error(err); } catch { }
        p.resolve();
      }
      if (!this.__connected) {
        try { openedReject(err); } catch { }
      }
    };

    const onEnd = () => {
      ended = true;
      finishEnded();
    };

    const onClose = () => {
      if (!this.__connected) {
        try { openedReject(new Error(`connection closed before established (${hostname}:${port})`)); } catch { }
      }
      ended = true;
      finishEnded();
      try { closedResolve(); } catch { }
    };

    sock.on("data", onChunk);
    sock.on("error", onError);
    sock.on("end", onEnd);
    sock.on("close", onClose);

    const onConnect = () => {
      this.__connected = true;
      try { openedResolve(); } catch { }
    };
    if (useTls) sock.once("secureConnect", onConnect);
    else sock.once("connect", onConnect);

    const readable = new ReadableStream({
      type: "bytes",
      autoAllocateChunkSize: AUTO_CHUNK,
      start(controller) { controllerRef = controller; },
      pull(controller) {
        if (queue.length > 0) {
          const buf = queue.shift();
          queuedBytes -= buf.length;
          try { controller.enqueue(toPlainU8(buf)); } catch { return; }
          tryResume();
          if (queue.length === 0 && ended) {
            try { controller.close(); } catch { }
          }
          return;
        }
        if (errored) throw errored;
        if (ended) {
          try { controller.close(); } catch { }
          return;
        }
        return new Promise((resolve) => { pendingPull = { resolve, controller }; });
      },
      cancel() {
        try { sock.destroy(); } catch { }
      },
    });

    // ---- writable stream ----
    const writable = new WritableStream({
      async write(chunk) {
        const buf = toBuffer(chunk);
        return new Promise((resolve, reject) => {
          if (sock.destroyed || sock.writableEnded) {
            reject(new Error("socket is closed"));
            return;
          }
          const cb = (err) => { if (err) reject(err); else resolve(); };
          try {
            sock.write(buf, cb);
          } catch (e) {
            reject(e);
          }
        });
      },
      close() {
        return new Promise((resolve) => {
          try { sock.end(() => resolve()); } catch { resolve(); }
        });
      },
      abort() {
        try { sock.destroy(); } catch { }
      },
    });

    // non-enumerable so console/logging stays clean
    Object.defineProperties(this, {
      readable: { value: readable, enumerable: true },
      writable: { value: writable, enumerable: true },
    });
  }

  close() {
    return new Promise((resolve) => {
      const sock = this.__sock;
      if (sock.destroyed) { resolve(); return; }
      // Flush pending writes first; destroy only after 'finish' (or a short safety timeout).
      const timer = setTimeout(() => { try { sock.destroy(); } catch { } resolve(); }, 2000);
      timer.unref?.();
      sock.once("close", () => { clearTimeout(timer); resolve(); });
      try { sock.end(() => { try { sock.destroy(); } catch { } }); } catch { try { sock.destroy(); } catch { } }
    });
  }

  get upgraded() { return false; }
  get protocol() { return null; }
  get extendedErrorLogKey() { return `${this.__address.hostname}:${this.__address.port}`; }
}

export function connect(address, options = {}) {
  return new TCPSocket(address, options);
}

export default { connect };
