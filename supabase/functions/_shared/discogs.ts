/* Shared helpers for the Discogs OAuth 1.0a handshake.
 *
 * Signature method is PLAINTEXT, per Discogs' own recommendation:
 *   "we suggest sending requests with HTTPS and the PLAINTEXT signature method over
 *    HMAC-SHA1 due to its simple yet secure nature."
 * There is no signing algorithm here -- the signature is a string.
 *
 * Measured 2026-08-28 against the live API: Discogs accepts the signature both raw ("&")
 * and percent-encoded ("%26"), so percent-encoding every value is safe. */

export const DISCOGS_UA = 'TraxWax/1.0 +https://traxwax.com';

/** RFC 3986 percent-encoding. encodeURIComponent leaves !'()* alone; OAuth wants them encoded. */
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function oauthHeader(params: Record<string, string>): string {
  return 'OAuth ' + Object.entries(params)
    .map(([k, v]) => `${k}="${pct(v)}"`)
    .join(', ');
}

export function nonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** Names only, never values — for logging an unexpected OAuth response safely. */
export function fieldNames(body: string): string {
  return Object.keys(parseForm(body)).join(',') || '(none)';
}

/* ── AES-256-GCM at rest ─────────────────────────────────────────────────────
   Stored format: base64( iv(12) || ciphertext||tag ). Self-contained, so no separate IV
   column and no chance of pairing the wrong IV with the wrong row. */

function b64encode(bytes: Uint8Array): string {
  // A loop, not String.fromCharCode(...spread): the spread form blows the argument limit
  // on large inputs, and this module is explicitly built for reuse.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function keyFor(rawBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(rawBase64.trim()), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) {
    throw new Error('DISCOGS_TOKEN_ENC_KEY must decode to exactly 32 bytes');
  }
  return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false,
    ['encrypt', 'decrypt']);
}

export async function encrypt(plain: string, keyB64: string): Promise<string> {
  const key = await keyFor(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const joined = new Uint8Array(iv.byteLength + ct.byteLength);
  joined.set(iv, 0);
  joined.set(ct, iv.byteLength);
  return b64encode(joined);
}

export async function decrypt(stored: string, keyB64: string): Promise<string> {
  const key = await keyFor(keyB64);
  const joined = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: joined.slice(0, 12) }, key, joined.slice(12));
  return new TextDecoder().decode(plain);
}

/** Encrypt→decrypt round trip. Stage B only encrypts; without this, a decrypt bug would
    stay hidden until Stage C discovers it on real stored tokens. */
export async function selfTest(keyB64: string): Promise<void> {
  const probe = 'traxwax-selftest-' + crypto.randomUUID();
  if (await decrypt(await encrypt(probe, keyB64), keyB64) !== probe) {
    throw new Error('crypto self-test failed');
  }
}
