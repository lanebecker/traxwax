import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { encrypt, decryptWithKeys } from './discogs.ts';

// Two distinct, valid 32-byte base64 keys.
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff)));

// Reproduce the LEGACY framing (iv(12)||ct) that pre-#161 rows use, under a chosen key.
async function legacyEncrypt(plain: string, keyB64: string): Promise<string> {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain)));
  const joined = new Uint8Array(12 + ct.byteLength);
  joined.set(iv, 0); joined.set(ct, 12);
  let s = ''; for (let i = 0; i < joined.length; i++) s += String.fromCharCode(joined[i]);
  return btoa(s);
}

Deno.test('versioned round-trip (single current key)', async () => {
  const blob = await encrypt('hello-token', KEY_A);
  assertEquals(await decryptWithKeys(blob, [KEY_A]), 'hello-token');
});

Deno.test('legacy blob reads with the same key (back-compat, the ship-time case)', async () => {
  const legacy = await legacyEncrypt('legacy-token', KEY_A);
  assertEquals(await decryptWithKeys(legacy, [KEY_A]), 'legacy-token');
});

Deno.test('ROTATION: legacy blob (old key A) reads with [new B, prev A] — no orphaning', async () => {
  const legacy = await legacyEncrypt('rolled-token', KEY_A);
  assertEquals(await decryptWithKeys(legacy, [KEY_B, KEY_A]), 'rolled-token');
});

Deno.test('ROTATION: legacy blob (old key A) THROWS with only new key B — the #161 orphan', async () => {
  const legacy = await legacyEncrypt('rolled-token', KEY_A);
  await assertRejects(() => decryptWithKeys(legacy, [KEY_B]));
});

Deno.test('versioned blob written by A is unreadable with only B (no false positive)', async () => {
  const blob = await encrypt('a-only', KEY_A);
  await assertRejects(() => decryptWithKeys(blob, [KEY_B]));
});

Deno.test('versioned blob written by A reads with [B, A] via keyid match', async () => {
  const blob = await encrypt('via-prev', KEY_A);
  assertEquals(await decryptWithKeys(blob, [KEY_B, KEY_A]), 'via-prev');
});

Deno.test('malformed prev key is SKIPPED, current-key blob still reads (MUST-FIX 1)', async () => {
  const blob = await encrypt('safe', KEY_A);
  assertEquals(await decryptWithKeys(blob, [KEY_A, '@@not-base64@@']), 'safe');
  assertEquals(await decryptWithKeys(blob, [KEY_A, btoa('short')]), 'safe');
});

Deno.test('all-invalid key list throws', async () => {
  const blob = await encrypt('x', KEY_A);
  await assertRejects(() => decryptWithKeys(blob, ['@@bad@@', btoa('short')]));
});

Deno.test('non-base64 plaintext throws (callback raw-fallback still fires)', async () => {
  await assertRejects(() => decryptWithKeys('not valid base64 !!!', [KEY_A]));
});

Deno.test('empty string throws', async () => {
  await assertRejects(() => decryptWithKeys('', [KEY_A]));
});
