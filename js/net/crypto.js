// Crypto for rooms, all WebCrypto.
//
// The invite link carries a 16-byte room secret in the URL fragment (never
// sent to any server). From it we derive the relay topic and an AES-GCM key
// that wraps every message, so the public relays only ever see ciphertext.
// Each browser also holds an ECDH key pair; its fingerprint is the player's id,
// and host<->player traffic is sealed with a pairwise key on top, so one
// player can neither read another's private view nor forge their moves.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function b64u(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64');
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const randomId = (bytes = 9) => b64u(randomBytes(bytes));

async function sha256(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return new Uint8Array(await subtle.digest('SHA-256', buf));
}

// ---------- room ----------

export function newRoomSecret() {
  return b64u(randomBytes(16));
}

export async function roomFromSecret(secret) {
  const raw = fromB64u(secret);
  if (raw.length !== 16) throw new Error('bad room secret');
  const id = b64u(await sha256('facet/topic/', raw)).slice(0, 16);
  const keyBytes = await sha256('facet/key/', raw);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key, secretBytes: raw };
}

// ---------- AES-GCM wrapping ----------

export async function seal(key, obj) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

// Returns the parsed object, or null for anything that isn't ours.
export async function open(key, bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 29 || bytes[0] !== 1) return null;
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) }, key, bytes.subarray(13));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export const sealText = async (key, obj) => b64u(await seal(key, obj));
export async function openText(key, text) {
  try { return await open(key, fromB64u(text)); } catch { return null; }
}

// ---------- identities ----------

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export async function fingerprint(pubB64) {
  return b64u(await sha256('facet/id/', fromB64u(pubB64))).slice(0, 12);
}

export async function createIdentity() {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const pub = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  return loadIdentity({ jwk, pub });
}

// `stored` is the JSON-safe form kept in browser storage: { jwk, pub }.
export async function loadIdentity(stored) {
  const privateKey = await subtle.importKey('jwk', stored.jwk, ECDH, false, ['deriveBits']);
  return { id: await fingerprint(stored.pub), pub: stored.pub, privateKey, stored };
}

// Symmetric key shared by exactly two identities in one room.
export async function pairKey(identity, peerPub, roomSecretBytes) {
  const peer = await subtle.importKey('raw', fromB64u(peerPub), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, identity.privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const ids = [identity.id, await fingerprint(peerPub)].sort().join('|');
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: roomSecretBytes, info: enc.encode(`facet/pair/${ids}`) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
