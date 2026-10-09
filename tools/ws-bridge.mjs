#!/usr/bin/env node
// WebVNA automation bridge: a tiny dependency-free WebSocket relay (RFC 6455, Node >= 22) between the WebVNA page and scripts.
//
//   node tools/ws-bridge.mjs [--port 8765] [--token SECRET] [--origin https://host]
//
//   ws://127.0.0.1:PORT/app?token=...     the WebVNA page (Script tab > Automation bridge). One at a time; a new one replaces the old.
//   ws://127.0.0.1:PORT/client?token=...  Python or any other script. Any number.
//
// Messages are JSON text. client -> {id, method, params}; the bridge forwards it to the page with its own unique id and routes the
// page's {id, result | error} back to that client under the client's id. The page's {event, data} messages go to every client.
// The bridge also sends clients {event:"app", data:{connected}} when the page connects or goes away.
// It listens on 127.0.0.1 only. Browsers always send an Origin header, so /client refuses requests that carry one (a web page
// cannot drive your device through this port); /app accepts any Origin unless --origin is given.
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_PAYLOAD = 16 * 1024 * 1024;
const PING_MS = 20000;

const sha = (s) => createHash("sha256").update(s).digest();

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

/** Wrap a raw socket: parses client frames, reassembles fragments, answers ping/close. Callbacks: onMessage(text), onClose(). */
class Peer {
  constructor(socket, role, handlers) {
    this.socket = socket;
    this.role = role;
    this.handlers = handlers;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragSize = 0;
    this.alive = true;
    this.closed = false;
    this.closing = false;
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.finish());
    socket.on("error", () => socket.destroy());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  send(text) {
    if (!this.closed && this.socket.writable) this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = "") {
    if (this.closed || !this.socket.writable) { this.socket.destroy(); return; }
    const r = Buffer.from(reason, "utf8").subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.socket.end(encodeFrame(0x8, p));
    // Keep reading (and discarding) what the peer is still sending: destroying the socket mid-upload makes the
    // kernel reset the connection, and the peer then loses our close frame. Give up after 1 s of silence.
    this.closing = true;
    this.buf = Buffer.alloc(0);
    this.idle();
  }

  idle() {
    clearTimeout(this.drain);
    this.drain = setTimeout(() => this.socket.destroy(), 1000);
    this.drain.unref();
  }

  onData(d) {
    if (this.closing) return this.idle();
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (b[0] & 0x70) return this.close(1002, "reserved bits");
      if (!masked) return this.close(1002, "client frames must be masked");
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009, "message too big");
        len = Number(big); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009, "message too big");
      if (opcode >= 0x8 && (len > 125 || !fin)) return this.close(1002, "bad control frame");
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (opcode === 0x8) { this.close(len >= 2 ? data.readUInt16BE(0) : 1000); return; }
      if (opcode === 0x9) { if (this.socket.writable) this.socket.write(encodeFrame(0xa, data)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragments.length) return this.close(1002, "unfinished fragmented message");
        this.fragments.push(data); this.fragSize = len;
      } else if (opcode === 0x0) {
        if (!this.fragments.length) return this.close(1002, "unexpected continuation");
        this.fragments.push(data); this.fragSize += len;
        if (this.fragSize > MAX_PAYLOAD) return this.close(1009, "message too big");
      } else return this.close(1002, "unknown opcode");
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = []; this.fragSize = 0;
        this.handlers.onMessage(text);
      }
    }
  }
}

/**
 * Start the relay. Resolves with { server, port, close() } once listening.
 * options: { port = 8765, host = "127.0.0.1", token, origin, log }
 */
export function startBridge({ port = 8765, host = "127.0.0.1", token = "", origin = "", log = () => {} } = {}) {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("The bridge only binds to localhost.");
  let app = null;
  const clients = new Set();
  const pending = new Map(); // bridge id -> { client, id }
  let nextId = 1;

  const toClients = (obj) => { const s = JSON.stringify(obj); for (const c of clients) c.send(s); };
  const failPending = (message) => {
    for (const [, p] of pending) p.client.send(JSON.stringify({ id: p.id, error: { message } }));
    pending.clear();
  };

  const server = createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket" });
    res.end("WebVNA bridge: connect with a WebSocket to /app or /client\n");
  });

  const reject = (socket, code, text) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, socket) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://localhost");
    const role = url.pathname === "/app" ? "app" : url.pathname === "/client" ? "client" : null;
    if (!role) return reject(socket, 404, "Not Found");
    if (token) {
      const given = url.searchParams.get("token") ?? "";
      if (!timingSafeEqual(sha(given), sha(token))) return reject(socket, 401, "Unauthorized");
    }
    const o = req.headers.origin;
    if (role === "client" && o) return reject(socket, 403, "Forbidden");
    if (role === "app" && origin && o !== origin) return reject(socket, 403, "Forbidden");
    const key = req.headers["sec-websocket-key"];
    if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13")
      return reject(socket, 400, "Bad Request");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);

    if (role === "app") {
      if (app) { failPending("WebVNA page was replaced by a new connection"); app.close(4000, "replaced"); }
      const peer = new Peer(socket, "app", {
        onMessage: (text) => {
          let m;
          try { m = JSON.parse(text); } catch { return; }
          if (!m || typeof m !== "object") return;
          if (typeof m.event === "string") { toClients(m); return; }
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          const out = { id: p.id };
          if ("error" in m) out.error = m.error; else out.result = m.result;
          p.client.send(JSON.stringify(out));
        },
        onClose: () => {
          if (app === peer) { app = null; failPending("WebVNA page disconnected"); toClients({ event: "app", data: { connected: false } }); log("app disconnected"); }
        },
      });
      app = peer;
      log("app connected");
      toClients({ event: "app", data: { connected: true } });
      return;
    }

    const peer = new Peer(socket, "client", {
      onMessage: (text) => {
        let m;
        try { m = JSON.parse(text); } catch { return peer.send(JSON.stringify({ id: null, error: { message: "invalid JSON" } })); }
        const id = m && typeof m === "object" ? m.id : undefined;
        if (!m || typeof m !== "object" || typeof m.method !== "string") return peer.send(JSON.stringify({ id: id ?? null, error: { message: "expected {id, method, params}" } }));
        if (!app) return peer.send(JSON.stringify({ id, error: { message: "WebVNA page is not connected to the bridge" } }));
        const bid = nextId++;
        pending.set(bid, { client: peer, id });
        app.send(JSON.stringify({ id: bid, method: m.method, params: m.params ?? {} }));
      },
      onClose: () => {
        clients.delete(peer);
        for (const [k, p] of pending) if (p.client === peer) pending.delete(k);
      },
    });
    clients.add(peer);
  });

  // Drop peers that stopped answering pings.
  const timer = setInterval(() => {
    for (const p of [...clients, ...(app ? [app] : [])]) {
      if (!p.alive) { p.socket.destroy(); continue; }
      p.alive = false;
      if (p.socket.writable) p.socket.write(encodeFrame(0x9));
    }
  }, PING_MS);
  timer.unref();

  return new Promise((resolve, reject2) => {
    server.once("error", reject2);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === "object" && addr ? addr.port : port,
        close: () => new Promise((r) => {
          clearInterval(timer);
          for (const p of [...clients, ...(app ? [app] : [])]) p.socket.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--help")) {
    console.log("usage: node tools/ws-bridge.mjs [--port 8765] [--token SECRET] [--origin https://your.webvna.host]");
    process.exit(0);
  }
  const port = Number(arg("port") ?? 8765);
  const token = arg("token") ?? "";
  startBridge({ port, token, origin: arg("origin") ?? "", log: (m) => console.error(`[bridge] ${m}`) })
    .then((b) => {
      console.log(`listening on ws://127.0.0.1:${b.port} (/app, /client)${token ? " token required" : ""}`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
