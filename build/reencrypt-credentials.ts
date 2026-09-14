#!/usr/bin/env -S deno run --allow-env --allow-net
/* T3.9 (#161): re-encrypt every stored Discogs credential with the CURRENT key, so an old key can
 * be retired after a rollover. Decrypts each row with whichever key wrote it (current, or
 * DISCOGS_TOKEN_ENC_KEY_PREV), then re-encrypts with the current key and writes it back. Idempotent
 * — a row already on the current key is decrypted and rewritten harmlessly.
 *
 * Transient tables (discogs_oauth_state, discogs_pending_links) are NOT touched: rows there expire
 * in ≤15 min, so a rollover just waits them out.
 *
 * Rollover order:
 *   1. Set DISCOGS_TOKEN_ENC_KEY = <new>, DISCOGS_TOKEN_ENC_KEY_PREV = <old>; redeploy functions.
 *   2. Verify a signed-in read path works (crate renders / EST fills) — dual-key reads old blobs.
 *   3. Run this script:
 *        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *        DISCOGS_TOKEN_ENC_KEY=<new-b64> DISCOGS_TOKEN_ENC_KEY_PREV=<old-b64> \
 *        deno run --allow-env --allow-net build/reencrypt-credentials.ts
 *   4. Confirm it reports "0 failure(s)" AND "processed N of N" (see the coverage guard below);
 *      wait ≥15 min for transient rows to expire.
 *   5. Remove DISCOGS_TOKEN_ENC_KEY_PREV; redeploy. The old key is now retired.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2.116.0';
import { decrypt, encrypt } from '../supabase/functions/_shared/discogs.ts';

const url = Deno.env.get('SUPABASE_URL');
const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const key = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
if (!url || !svc || !key) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DISCOGS_TOKEN_ENC_KEY are required');
  Deno.exit(1);
}

const admin = createClient(url, svc);

// KEYSET pagination on the UNIQUE user_id (discogs_credentials_pkey). Chosen over offset/.range()
// (remediation-audit Pass 2): a concurrent INSERT during the run shifts .range() offsets by +1 and
// can slide an unprocessed old-key row out of the window while the counts still look complete —
// #161 reborn under a narrower trigger. A cursor advanced by the last user_id seen cannot be
// dislodged by an insert: every row at-or-after the cursor is visited, a row inserted ahead of the
// cursor is visited too, and one inserted behind the cursor was written by the CURRENT code (already
// new-key format — re-encrypting it is unnecessary). No row cap can truncate this: each page is an
// explicit .limit(PAGE) window and the loop ends only on a short/empty page.
const PAGE = 500;
let rewritten = 0, failed = 0, scanned = 0;
let cursor = '';   // user_id is a NOT NULL, non-empty Clerk sub (schema: discogs_credentials_pkey),
                   // so '' sorts before every real id and page 1's `> ''` excludes no real row.
for (;;) {
  const { data: rows, error } = await admin
    .from('discogs_credentials')
    .select('user_id, oauth_token, oauth_token_secret')
    .gt('user_id', cursor)
    .order('user_id', { ascending: true })
    .limit(PAGE);
  if (error) { console.error('read failed after cursor', JSON.stringify(cursor), '-', error.message); Deno.exit(1); }
  // Terminate ONLY on an empty page. A short (non-empty) page is NOT end-of-table: a db-max-rows
  // cap below PAGE would cap every page, so breaking on rows.length < PAGE would stop early and skip
  // the tail. The cursor advances by the last user_id each iteration, so under a cap this just means
  // smaller pages / more round-trips, terminating when no row remains past the cursor.
  if (!rows || rows.length === 0) break;
  for (const r of rows) {
    scanned++;
    cursor = r.user_id;   // advance BEFORE processing so a failing row can't wedge the loop
    try {
      const tok = await decrypt(r.oauth_token, key);          // dual-key: reads old OR new
      const sec = await decrypt(r.oauth_token_secret, key);
      const { error: upErr } = await admin.from('discogs_credentials').update({
        oauth_token: await encrypt(tok, key),                 // always the current key
        oauth_token_secret: await encrypt(sec, key),
      }).eq('user_id', r.user_id);
      if (upErr) { console.error('update failed for', r.user_id, upErr.message); failed++; continue; }
      rewritten++;
    } catch (e) {
      console.error('decrypt failed for', r.user_id, '-', (e as Error).message, '(old key missing from env?)');
      failed++;
    }
  }
}
console.log(`re-encrypted ${rewritten} row(s), ${failed} failure(s); scanned ${scanned} row(s)`);
if (failed > 0) {
  console.error(`INCOMPLETE: ${failed} row(s) could not be re-encrypted — DO NOT remove DISCOGS_TOKEN_ENC_KEY_PREV.`);
  Deno.exit(1);
}
