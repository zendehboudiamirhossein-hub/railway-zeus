/**
 * CHOPEX Panel — Node.js / Railway host for the original Cloudflare Worker.
 *
 * The worker file (worker/panel.js) is loaded 100% unmodified. Every Cloudflare
 * runtime feature it needs is emulated here or in src/shims/:
 *   - cloudflare:sockets   -> node:net / node:tls      (src/shims/sockets.mjs)
 *   - WebSocketPair / 101  -> ws + Response patch      (src/shims/globals.mjs)
 *   - caches.default       -> in-memory cache          (src/shims/globals.mjs)
 *   - env.DB (D1)          -> node:sqlite adapter      (src/shims/d1.mjs)
 *   - env.* variables      -> process.env
 */
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { WebSocketServer } from "ws";
import { patchGlobals, makeExecContext } from "./src/shims/globals.mjs";
import { createD1 } from "./src/shims/d1.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 0) Crash-resistance: log and keep serving (Railway restarts on real crashes)
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err && (err.stack || err.message || err)));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err && (err.stack || err.message || err)));

// ---------------------------------------------------------------------------
// 1) Module hooks MUST be installed before the worker module is loaded
// ---------------------------------------------------------------------------
register(pathToFileURL(path.join(__dirname, "src", "loader-hooks.mjs")));

// ---------------------------------------------------------------------------
// 2) Patch globals (Response 101 / WebSocketPair / caches)
// ---------------------------------------------------------------------------
patchGlobals();

// ---------------------------------------------------------------------------
// 3) Environment & bindings
// ---------------------------------------------------------------------------
const ROOT_DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH; // if a volume is attached
const DEFAULT_DB_PATH = ROOT_DATA_DIR
  ? path.join(ROOT_DATA_DIR, "panel.db")
  : path.join(__dirname, "data", "panel.db");
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

const env = {
  DB: createD1(DB_PATH),
  CF_API_TOKEN: process.env.CF_API_TOKEN || null,
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || null,
  WORKER_NAME: process.env.WORKER_NAME || null,
};

// ---------------------------------------------------------------------------
// 4) Load the original worker (unchanged)
// ---------------------------------------------------------------------------
const workerModule = await import(pathToFileURL(path.join(__dirname, "worker", "panel.js")).href);
const worker = workerModule.default;
if (!worker || typeof worker.fetch !== "function") {
  console.error("FATAL: worker default export with fetch() not found in worker/panel.js");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5) HTTP <-> Web API bridge
// ---------------------------------------------------------------------------
function normalizeIp(ip) {
  if (!ip) return "unknown";
  ip = String(ip).trim();
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}

function buildWebRequest(req, extraHeaders) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = xfProto || (req.socket.encrypted ? "https" : "http");
  const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = xfHost || req.headers.host || "localhost";
  const url = `${proto}://${host}${req.url || "/"}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }

  // Client IP: never trust a client-supplied CF-Connecting-IP (we are not behind Cloudflare).
  // Prefer the proxy's X-Real-IP, then the LAST X-Forwarded-For hop (appended by the trusted proxy).
  const xff = (headers.get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const cip = String(req.headers["x-real-ip"] || "").trim()
    || xff[xff.length - 1]
    || req.socket.remoteAddress
    || "unknown";
  headers.delete("cf-connecting-ip");
  headers.set("cf-connecting-ip", normalizeIp(cip));

  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

const HOP_BY_HOP = new Set([
  "transfer-encoding", "connection", "keep-alive", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
]);

function copyHeadersToNode(webHeaders) {
  const out = {};
  webHeaders.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === "content-length") return;
    if (k === "set-cookie") return; // handled separately
    out[key] = value;
  });
  let setCookies;
  try {
    setCookies = typeof webHeaders.getSetCookie === "function" ? webHeaders.getSetCookie() : null;
  } catch { setCookies = null; }
  if (setCookies && setCookies.length) {
    out["Set-Cookie"] = setCookies;
  }
  return out;
}

async function sendResponseToNode(res, nodeRes, reqMethod) {
  const headers = copyHeadersToNode(res.headers);
  nodeRes.statusCode = res.status;
  nodeRes.statusMessage = res.statusText || "";
  nodeRes.writeHead(res.status, headers);

  if (reqMethod === "HEAD" || res.status === 204 || res.status === 304 || !res.body) {
    nodeRes.end();
    return;
  }
  const bodyStream = Readable.fromWeb(res.body);
  bodyStream.on("error", () => {
    try { nodeRes.destroy(); } catch { }
  });
  bodyStream.pipe(nodeRes);
}

// ---------------------------------------------------------------------------
// 6) Servers
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const server = http.createServer(async (req, res) => {
  try {
    const request = buildWebRequest(req);
    const response = await worker.fetch(request, env, makeExecContext());
    if (response && response.__cfWsAccept) {
      // WS accept returned over a plain HTTP request — nothing useful to do
      res.statusCode = 426;
      res.end("Upgrade Required");
      return;
    }
    await sendResponseToNode(response, res, req.method || "GET");
  } catch (err) {
    console.error("[http-error]", err && (err.stack || err.message || err));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      try { res.destroy(); } catch { }
    }
  }
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 8 * 1024 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  (async () => {
    const request = buildWebRequest(req);
    let response = null;
    try {
      response = await worker.fetch(request, env, makeExecContext());
    } catch (err) {
      console.error("[ws-upgrade-error]", err && (err.stack || err.message || err));
      socket.destroy();
      return;
    }

    const clientShim = response && response.webSocket;
    if (!response || response.status !== 101 || !clientShim || !clientShim.__pair) {
      // Worker rejected the upgrade — reply with its HTTP response
      const status = response ? response.status : 500;
      const body = response ? await response.text() : "Internal Server Error";
      const headers = response ? copyHeadersToNode(response.headers) : {};
      const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ""}`];
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) { for (const item of v) lines.push(`${k}: ${item}`); }
        else lines.push(`${k}: ${v}`);
      }
      lines.push("Connection: close");
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.end(lines.join("\r\n") + "\r\n\r\n" + body);
      return;
    }

    const serverShim = clientShim.__pair;
    wss.handleUpgrade(req, socket, head, (ws) => {
      serverShim.__bind(ws);
    });
  })().catch((err) => {
    console.error("[ws-upgrade-fatal]", err && (err.stack || err.message || err));
    try { socket.destroy(); } catch { }
  });
});

// Long-lived connections (WS + streamed subscriptions) need relaxed timeouts
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 90_000;

server.listen(PORT, HOST, () => {
  console.log(`CHOPEX Panel (Node/Railway runtime) listening on http://${HOST}:${PORT}`);
  console.log(`- DB: ${DB_PATH}`);
  console.log(`- CF integration vars: ${env.CF_API_TOKEN && env.CF_ACCOUNT_ID ? "set" : "not set (optional feature disabled)"}`);
});
