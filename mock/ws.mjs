// The /ws endpoint of the mock daemon (duo #16) — the server half of
// src/api/ws.ts's contract, implemented raw: the handshake is one SHA-1 and
// the only frames that ever cross the wire are small text ones. No
// ping/pong negotiation beyond echoing a ping, no fragmentation (the
// client's messages are a few dozen bytes), no spontaneity — `broadcast` is
// fed exclusively by the mock's own routes.
//
// Auth is by first message, not header: the browser WebSocket API cannot
// set an Authorization header, so the client sends {type:"auth",token} on
// open and expects {type:"ready"} back — exactly the shape digital-duo
// #162 specifies.

import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// The client treats this close code as "bad token, stop reconnecting" —
// the mock only ever sends it for an empty one.
const AUTH_CLOSE_CODE = 4001;

const TEXT = 0x1;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** One outbound text frame. Server-to-client frames are never masked. */
function sendText(socket, payload) {
  const data = Buffer.from(payload, "utf8");
  const header = data.length < 126 ? Buffer.from([0x80 | TEXT, data.length]) : Buffer.from([0x80 | TEXT, 126, data.length >> 8, data.length & 0xff]);
  socket.write(Buffer.concat([header, data]));
}

function sendClose(socket, code) {
  socket.write(Buffer.from([0x80 | CLOSE, 2, code >> 8, code & 0xff]));
  socket.end();
}

function sendPong(socket, payload) {
  socket.write(Buffer.concat([Buffer.from([0x80 | PONG, payload.length]), payload]));
}

/**
 * Parses complete frames out of a socket's receive buffer as they arrive.
 * Returns the remaining bytes that belong to a still-incomplete frame.
 * Only the minimum the mock's clients send: masked text/close/ping frames
 * of any 7/16-bit length, which covers messages far larger than auth ever
 * is. Anything else is skipped, frame by frame, without killing the socket.
 */
function drainFrames(socket, buffer, onMessage) {
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) {
      break;
    }
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) {
        break;
      }
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) {
        break;
      }
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(1024 * 1024)) {
        sendClose(socket, 1009);
        return null;
      }
      length = Number(big);
      cursor += 8;
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) {
      cursor += 4;
    }
    if (buffer.length - cursor < length) {
      break;
    }
    const payload = buffer.subarray(cursor, cursor + length);
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    offset = cursor + length;
    if (opcode === TEXT) {
      onMessage(payload.toString("utf8"));
    } else if (opcode === PING) {
      sendPong(socket, payload);
    } else if (opcode === CLOSE) {
      sendClose(socket, 1000);
      return null;
    }
  }
  return buffer.subarray(offset);
}

/**
 * Attaches the one push channel to an existing http server. Returns
 * `broadcast(message)` — JSON-stringifies and fan-outs to every authed
 * socket; routes call it with {type:"draft-ready",draftId}.
 */
export function attachDraftReadySocket(server) {
  const sockets = new Set();

  server.on("upgrade", (req, socket) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const key = req.headers["sec-websocket-key"];
    if (pathname !== "/ws" || !key) {
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    sockets.add(socket);

    let backlog = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      backlog = Buffer.concat([backlog, chunk]);
      const outcome = drainFrames(socket, backlog, (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return; // not JSON: nothing in this protocol to do with it
        }
        if (message?.type === "auth" && typeof message.token === "string" && message.token !== "") {
          sendText(socket, JSON.stringify({ type: "ready" }));
        } else if (message?.type === "auth") {
          sockets.delete(socket);
          sendClose(socket, AUTH_CLOSE_CODE);
        }
      });
      if (outcome === null) {
        socket.destroy();
        return;
      }
      backlog = outcome;
    });
    const drop = () => sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  return {
    broadcast(message) {
      const frame = JSON.stringify(message);
      for (const socket of sockets) {
        sendText(socket, frame);
      }
    },
  };
}
