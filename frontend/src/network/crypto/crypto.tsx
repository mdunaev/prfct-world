import { md, pki, util } from "node-forge";
import libsodium from "libsodium-wrappers";
import { Key, Message, SignedMessage } from "../interfaces";

//_ node-forge returns keys and signatures as Uint8Array in a browser and as Buffer in node.js
const bytesToHex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const signMessage = (message: Message): SignedMessage => {
  const messageHash = md.md5.create().update(JSON.stringify(message)).digest().toHex();
  const signature = pki.ed25519.sign({
    message: messageHash,
    encoding: "utf8",
    privateKey: util.hexToBytes(key.privateKey),
  });

  return {
    stage: "",
    raw: message,
    signature: bytesToHex(signature),
  };
};

// Duplicate from server/index.ts
export const verifyMessage = (message: SignedMessage) => {
  try {
    const messageHash = md.md5.create().update(JSON.stringify(message.raw)).digest().toHex();
    return pki.ed25519.verify({
      message: messageHash,
      encoding: "utf8",
      signature: util.hexToBytes(message.signature),
      publicKey: util.hexToBytes(message.raw.from),
    });
  } catch (error) {
    // malformed message (wrong key or signature length, missing fields)
    return false;
  }
};

//_ Sign any data with my key. Used for actions and blocks, which are relayed by other peers
//_ and so can not rely on the signature of the transport message.
//_ The digest is SHA-256 of UTF-8 bytes, not getHashFromData: the legacy hash reads a string as
//_ raw bytes, so two different strings with non-latin symbols can have the same hash.
const getSignDigest = (data: any) =>
  md.sha256
    .create()
    .update(JSON.stringify(data || {}), "utf8")
    .digest()
    .toHex();

export const signData = (data: any): string => {
  const signature = pki.ed25519.sign({
    message: getSignDigest(data),
    encoding: "utf8",
    privateKey: util.hexToBytes(key.privateKey),
  });
  return bytesToHex(signature);
};

export const verifyData = (data: any, signature: string | undefined, publicKey: string) => {
  if (typeof signature !== "string" || typeof publicKey !== "string") return false;
  try {
    return pki.ed25519.verify({
      message: getSignDigest(data),
      encoding: "utf8",
      signature: util.hexToBytes(signature),
      publicKey: util.hexToBytes(publicKey),
    });
  } catch (error) {
    return false;
  }
};

export const getHashFromData = (data: any) =>
  md.md5
    .create()
    .update(JSON.stringify(data || {}))
    .digest()
    .toHex();

export const generateKey = (): Key => {
  const _key = pki.ed25519.generateKeyPair();
  return {
    publicKey: bytesToHex(_key.publicKey),
    privateKey: bytesToHex(_key.privateKey),
  };
};

let key: Key = { privateKey: "", publicKey: "" };

export const getKeys = () => key;

export const changeKeys = (_key: Key) => {
  key = _key;
  return key;
};

export const myHexid = () => key.publicKey;

export const maxPositionLength = 6;
export const maxPositionValue = parseInt("f".repeat(maxPositionLength), 16);

export const getHexPosition = (hexid: string = "") =>
  parseInt(hexid.slice(0, maxPositionLength), 16);

export const getHexDistance = (hexid1: string, hexid2: string) => {
  const position1 = getHexPosition(hexid1);
  const position2 = getHexPosition(hexid2);
  const distance1 = Math.abs(position1 - position2);
  const distance2 = Math.abs(position1 - maxPositionValue - position2);
  const distance3 = Math.abs(position1 + maxPositionValue - position2);
  return Math.min(distance1, distance2, distance3);
};

//
// Encription
//

// async Approved
const startLibsodium = async () => {
  await libsodium.ready;
};
startLibsodium();

//_ Encrypted message format: base64(nonce + ciphertext).
//_ The nonce is random for every message: reusing a nonce with the same key pair
//_ lets an eavesdropper recover the plaintext.
export const encryptFor = (recipient: string, message: string) => {
  const recipientCurvePublic = libsodium.crypto_sign_ed25519_pk_to_curve25519(
    libsodium.from_hex(recipient)
  );
  const myCurvePrivate = libsodium.crypto_sign_ed25519_sk_to_curve25519(
    libsodium.from_hex(key.privateKey)
  );

  const nonce = libsodium.randombytes_buf(libsodium.crypto_box_NONCEBYTES);
  const cipher = libsodium.crypto_box_easy(
    message,
    nonce,
    recipientCurvePublic,
    myCurvePrivate,
    "uint8array"
  );

  const result = new Uint8Array(nonce.length + cipher.length);
  result.set(nonce);
  result.set(cipher, nonce.length);

  return libsodium.to_base64(result);
};

export const decryptFrom = (from: string, message: string) => {
  const fromCurvePublic = libsodium.crypto_sign_ed25519_pk_to_curve25519(libsodium.from_hex(from));

  const myCurvePrivate = libsodium.crypto_sign_ed25519_sk_to_curve25519(
    libsodium.from_hex(key.privateKey)
  );

  const bytes = libsodium.from_base64(message);
  const nonce = bytes.slice(0, libsodium.crypto_box_NONCEBYTES);
  const cipher = bytes.slice(libsodium.crypto_box_NONCEBYTES);

  return libsodium.crypto_box_open_easy(cipher, nonce, fromCurvePublic, myCurvePrivate, "text");
};

export const isValidHexId = (hexId: string) => {
  try {
    return !!libsodium.crypto_sign_ed25519_pk_to_curve25519(libsodium.from_hex(hexId));
  } catch (e) {
    return false;
  }
};
