import express from "express";
import { Socket, Server } from "socket.io";
import { md, pki } from "node-forge";

import { RateLimiterMemory } from "rate-limiter-flexible";

// Crypto
// Duplicate from frontend/src/crypto.ts
export const verifyMessage = (message: SignedMessage) => {
  try {
    const messageHash = md.md5
      .create()
      .update(JSON.stringify(message.raw))
      .digest()
      .toHex();
    return pki.ed25519.verify({
      message: messageHash,
      encoding: "utf8",
      signature: Buffer.from(message.signature, "hex"),
      publicKey: Buffer.from(message.raw.from, "hex"),
    });
  } catch (error) {
    // malformed message (wrong key or signature length, missing fields)
    return false;
  }
};

const isSignedMessage = (message: any): message is SignedMessage =>
  !!message &&
  typeof message.signature === "string" &&
  !!message.raw &&
  typeof message.raw.from === "string" &&
  typeof message.raw.to === "string" &&
  typeof message.raw.type === "string";

// HTTP Server
const app = express();

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.listen(8080, () => {
  console.log(`Prfct entrance backend started ^_^`);
});

// Socket.IO Server
// CORS is open: the gate only relays signed messages and has no cookies or sessions.
const io = new Server({ cors: { origin: "*" } });

const rateLimiter = new RateLimiterMemory({
  points: 30,
  duration: 1,
});

// WebRTC ICE servers
// With TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN the gate hands out Twilio STUN/TURN servers.
// Without them it falls back to a public STUN server (no TURN, so strict NATs will not connect).
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const fallbackIceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let twilioClient: any;
if (accountSid && authToken) {
  try {
    twilioClient = require("twilio")(accountSid, authToken);
  } catch (error) {
    console.error("Twilio init failed, using public STUN:", error);
  }
} else {
  console.log("Twilio keys are not set, using public STUN");
}

const getIceConfig = async () => {
  if (!twilioClient) return fallbackIceConfig;
  try {
    return await twilioClient.tokens.create();
  } catch (error) {
    console.error("Twilio token request failed, using public STUN:", error);
    return fallbackIceConfig;
  }
};

const connections: Record<string, Socket> = {};

const broadcastStatus = () =>
  io.emit("status", { connections: Object.keys(connections) });

io.on("connection", (socket: Socket) => {
  let socketHexid: string;
  let heartbeatIndicator = true;

  getIceConfig().then((token: any) => socket.emit("webrtc-ice", token));

  socket.on("message", async (message: SignedMessage) => {
    rateLimiter
      .consume(socketHexid || socket.id, 1)
      .then(() => {
        if (!isSignedMessage(message) || !verifyMessage(message)) return;

        heartbeatIndicator = true;
        if (message.raw.to === "gate") {
          switch (message.raw.type) {
            case "LOGIN":
              socketHexid = message.raw.from;
              connections[message.raw.from] = socket;
              broadcastStatus();
              break;
          }
          return;
        }
        if (connections[message.raw.to] && message.raw.type === "WEBRTC") {
          connections[message.raw.to].emit("message", message);
        }
      })
      .catch(() => {
        // rate limit exceeded - drop the message
      });
  });

  socket.on("disconnect", () => {
    clearInterval(timer);
    // the same key may have logged in again from another socket - keep that one
    if (socketHexid && connections[socketHexid] === socket) {
      delete connections[socketHexid];
      broadcastStatus();
    }
  });

  const timer = setInterval(() => {
    if (heartbeatIndicator) {
      heartbeatIndicator = false;
    } else {
      socket.disconnect();
      clearInterval(timer);
    }
  }, 60 * 1000);
});

io.listen(8070);

// Intrfaces
// Duplicate from frontend/src/crypto.ts
export interface SignedMessage {
  raw: Message;
  signature: string;
}
// Duplicate from frontend/src/crypto.ts
export interface Message<T = any> {
  from: string;
  to: string;
  type: string;
  ttr: number;
  data?: T;
}
