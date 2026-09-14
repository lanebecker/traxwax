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

/** Names only, never values — for logging an unexpected OAuth response safely.
 *  Audit T1.5: URLSearchParams treats a NON-form body (a JSON/HTML error page) as a single
 *  key = the ENTIRE string, so the old version could echo an oauth_token_secret into the logs.
 *  Emit field names only when the body is genuinely form-encoded; otherwise a shape summary. */
export function fieldNames(body: string): string {
  const s = String(body ?? '');
  if (!/^[\w.\-%+]+=[^&]*(?:&[\w.\-%+]+=[^&]*)*$/.test(s.trim())) {
    return `(non-form body, ${s.length} bytes)`;
  }
  return Object.keys(parseForm(s)).map((k) => k.slice(0, 40)).join(',') || '(none)';
}

/* ── AES-256-GCM at rest ─────────────────────────────────────────────────────
   Versioned framing (T3.9 #161):

       byte 0        VERSION  (0x01)
       bytes 1..5    KEY ID   = first 4 bytes of SHA-256(raw 32-byte key)
       bytes 5..17   IV       = 12 random bytes
       bytes 17..    ciphertext || GCM tag
       — the whole thing base64'd.

   LEGACY framing (every row written before this deploy) has NO version/keyid:

       bytes 0..12   IV
       bytes 12..    ciphertext || GCM tag

   decrypt() reads BOTH. For a versioned blob it tries the KEY ID's matching key first, then
   falls back to trying EVERY configured key against BOTH framings — safe because AES-GCM's
   128-bit tag makes a wrong key/framing throw, never return garbage. So a key rotation is a
   two-key rollover (current + DISCOGS_TOKEN_ENC_KEY_PREV) that orphans nothing, and
   probeStoredCredentials fails LOUD if the configured keys cannot read a real stored row —
   the silent-orphan gap selfTest could never see. */

const VERSION = 0x01;
const KEYID_LEN = 4;
const IV_LEN = 12;

function b64encode(bytes: Uint8Array): string {
  // A loop, not String.fromCharCode(...spread): the spread form blows the argument limit
  // on large inputs, and this module is explicitly built for reuse.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function rawKeyBytes(rawBase64: string): Uint8Array {
  const raw = Uint8Array.from(atob(rawBase64.trim()), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) {
    throw new Error('DISCOGS_TOKEN_ENC_KEY must decode to exactly 32 bytes');
  }
  return raw;
}

// Per-isolate cache: base64 key string -> {cryptoKey, keyid}. importKey + the keyid digest are
// pure functions of the key bytes, so caching them is safe and saves the work on every
// encrypt/decrypt in a warm isolate.
const keyCache = new Map<string, { cryptoKey: CryptoKey; keyid: Uint8Array }>();

async function keyMaterial(keyB64: string): Promise<{ cryptoKey: CryptoKey; keyid: Uint8Array }> {
  const cached = keyCache.get(keyB64);
  if (cached) return cached;
  const raw = rawKeyBytes(keyB64);
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false,
    ['encrypt', 'decrypt']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const material = { cryptoKey, keyid: digest.slice(0, KEYID_LEN) };
  keyCache.set(keyB64, material);
  return material;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function encrypt(plain: string, keyB64: string): Promise<string> {
  const { cryptoKey, keyid } = await keyMaterial(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(plain)));
  // VERSION(1) || KEYID(4) || IV(12) || ct||tag
  const joined = new Uint8Array(1 + KEYID_LEN + IV_LEN + ct.byteLength);
  joined[0] = VERSION;
  joined.set(keyid, 1);
  joined.set(iv, 1 + KEYID_LEN);
  joined.set(ct, 1 + KEYID_LEN + IV_LEN);
  return b64encode(joined);
}

async function tryDecrypt(cryptoKey: CryptoKey, iv: Uint8Array, ct: Uint8Array): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(plain);
}

/** Decrypt a stored blob against an ordered list of candidate keys (current first, then any
 *  previous key). Handles BOTH the versioned and legacy framings; throws only when NO
 *  candidate/framing authenticates. PURE (no env access) so it is unit-testable. */
export async function decryptWithKeys(stored: string, keyB64List: string[]): Promise<string> {
  const bytes = b64decode(stored);
  // Resolve each candidate key INDEPENDENTLY; a malformed key (bad base64 / not 32 bytes) is
  // SKIPPED, never fatal. Otherwise a fat-fingered DISCOGS_TOKEN_ENC_KEY_PREV would make
  // Promise.all reject and EVERY decrypt throw — reintroducing #161's TOTAL orphaning during the
  // exact rollover this code exists to make safe (plan-audit MUST-FIX 1).
  const materials = (await Promise.all(
    keyB64List.map((k) => keyMaterial(k).then((m) => m, () => null)),
  )).filter((m): m is { cryptoKey: CryptoKey; keyid: Uint8Array } => m !== null);
  if (materials.length === 0) throw new Error('decrypt failed: no valid key configured');
  const looksVersioned = bytes.length > 1 + KEYID_LEN + IV_LEN && bytes[0] === VERSION;

  // Fast path: versioned blob whose keyid matches a configured key.
  if (looksVersioned) {
    const keyid = bytes.slice(1, 1 + KEYID_LEN);
    const match = materials.find((m) => eqBytes(m.keyid, keyid));
    if (match) {
      try {
        return await tryDecrypt(match.cryptoKey,
          bytes.slice(1 + KEYID_LEN, 1 + KEYID_LEN + IV_LEN),
          bytes.slice(1 + KEYID_LEN + IV_LEN));
      } catch { /* fall through to the general path */ }
    }
  }

  // General path: try every key against BOTH framings. GCM authenticates, so a wrong
  // interpretation throws rather than returning garbage. Covers legacy blobs (no version
  // byte), a versioned blob whose keyid isn't configured, and the ~1/256 legacy blob whose
  // random first byte happens to equal VERSION.
  for (const m of materials) {
    if (bytes.length > IV_LEN) {
      try { return await tryDecrypt(m.cryptoKey, bytes.slice(0, IV_LEN), bytes.slice(IV_LEN)); }
      catch { /* next framing/key */ }
    }
    if (looksVersioned) {
      try {
        return await tryDecrypt(m.cryptoKey,
          bytes.slice(1 + KEYID_LEN, 1 + KEYID_LEN + IV_LEN),
          bytes.slice(1 + KEYID_LEN + IV_LEN));
      } catch { /* next key */ }
    }
  }
  throw new Error('decrypt failed: no configured key could read this credential');
}

/** Env-aware decrypt: current key (arg) first, then the optional previous key
 *  (DISCOGS_TOKEN_ENC_KEY_PREV) for an in-progress rollover. Call sites are unchanged. */
export async function decrypt(stored: string, keyB64: string): Promise<string> {
  let prev = '';
  try { prev = (Deno.env.get('DISCOGS_TOKEN_ENC_KEY_PREV') ?? '').trim(); } catch { prev = ''; }
  return await decryptWithKeys(stored, prev ? [keyB64, prev] : [keyB64]);
}

/** Encrypt→decrypt round trip on a FRESH value. Proves the CURRENT key is a valid 32-byte key
 *  that can round-trip — it CANNOT prove the key reads already-stored data (that is
 *  probeStoredCredentials' job; see T3.9/#161). Kept because it catches a malformed/missing key
 *  even when the credentials table is empty (bootstrap). */
export async function selfTest(keyB64: string): Promise<void> {
  const probe = 'traxwax-selftest-' + crypto.randomUUID();
  if (await decrypt(await encrypt(probe, keyB64), keyB64) !== probe) {
    throw new Error('crypto self-test failed');
  }
}

/** Startup gate (T3.9 #161): prove the configured key set can read REAL stored ciphertext, not just
 *  a fresh self-test. Pass a bounded sample of blobs from discogs_credentials (the two connect gates
 *  read `.limit(50)`; empty array when the table is empty — a fresh deploy must still boot). Throws on
 *  the FIRST blob no configured key can read — i.e. a key was rotated without carrying the old one,
 *  the exact silent-orphan scenario. The gates read an ORDERED, bounded sample
 *  (`.order('user_id').limit(50)`), so the check is deterministic and, for tables within that window,
 *  catches a partial migration; the eager reencrypt tool is the completeness mechanism beyond it. DB
 *  access stays in the caller so this module needs no client. */
export async function probeStoredCredentials(sampleBlobs: Array<string | null | undefined>, keyB64: string): Promise<void> {
  for (const blob of sampleBlobs) {
    if (blob) await decrypt(blob, keyB64);  // throws if no configured key can read this row
  }
}

/** SHA-256 as lowercase hex. The finalize code is stored only as this hash, so a DB read
    cannot complete a pending link. */
export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
