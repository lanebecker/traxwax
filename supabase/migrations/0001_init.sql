-- 0001_init.sql — TraxWax multi-user foundation (Phase 0)
--
-- Identity: Clerk. User ids are the Clerk `sub` claim (a text id like "user_2ab…"),
-- read inside RLS via auth.jwt()->>'sub'. So every user_id column is TEXT, not uuid.
--
-- Data tiering (Discogs API terms, spec §8): `releases` holds CC0 (public-domain) data
-- only and is world-readable. Prices / marketplace / community stats are NOT stored — they
-- are fetched live (≤6h) by an Edge Function in Phase 1. A user's Discogs OAuth token is a
-- SECRET and lives in `discogs_credentials`, which has RLS enabled and NO policies, so only
-- the service_role (which bypasses RLS) can ever read it.

-- ── profiles ───────────────────────────────────────────────────────────────────
-- One non-secret row per user. Safe for the owner to read.
create table if not exists public.profiles (
  user_id               text primary key,              -- Clerk auth.jwt()->>'sub'
  discogs_username      text,
  discogs_connected_at  timestamptz,
  last_import_at        timestamptz,
  import_status         text not null default 'idle'
                          check (import_status in ('idle','running','error')),
  display_name          text,
  created_at            timestamptz not null default now()
);

-- ── discogs_credentials ────────────────────────────────────────────────────────
-- SECRET. OAuth 1.0a access token + secret, per user. RLS on, no policies → clients
-- (anon/authenticated) can neither read nor write; only server-side service_role touches it.
create table if not exists public.discogs_credentials (
  user_id             text primary key,
  oauth_token         text not null,
  oauth_token_secret  text not null,
  created_at          timestamptz not null default now()
);

-- ── collection_items ───────────────────────────────────────────────────────────
-- Which releases a user owns + their personal fields. Sourced from their OAuth import.
create table if not exists public.collection_items (
  id           bigint generated always as identity primary key,
  user_id      text  not null,
  release_id   bigint not null,
  folder       text,
  rating       int   check (rating between 0 and 5),   -- the USER's personal rating
  added        date,
  vinyl        text,                                    -- variant, e.g. "Red, 180g"
  instance_id  bigint,                                  -- Discogs collection instance id
  created_at   timestamptz not null default now(),
  unique (user_id, instance_id)
);
create index if not exists collection_items_user_idx on public.collection_items (user_id);
create index if not exists collection_items_release_idx on public.collection_items (release_id);

-- ── releases (shared, global CC0 catalog) ──────────────────────────────────────
-- CC0 / public-domain fields only. thumb/cover_image are Discogs CDN URLs (a link that the
-- browser renders live from Discogs — image BYTES are not mirrored). No price/stat columns.
create table if not exists public.releases (
  release_id   bigint primary key,
  artist       text,
  title        text,
  year         int,
  label        text,
  styles       text[],
  genres       text[],
  thumb        text,
  cover_image  text,
  tracks       jsonb,
  country      text,
  released     text,
  videos       jsonb,
  enriched_at  timestamptz not null default now()
);

-- ── Row Level Security ─────────────────────────────────────────────────────────
alter table public.profiles            enable row level security;
alter table public.discogs_credentials enable row level security;   -- (no policies → locked)
alter table public.collection_items    enable row level security;
alter table public.releases            enable row level security;

-- profiles: owner-only.
create policy profiles_select_own on public.profiles
  for select using (auth.jwt()->>'sub' = user_id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.jwt()->>'sub' = user_id);
create policy profiles_update_own on public.profiles
  for update using (auth.jwt()->>'sub' = user_id)
             with check (auth.jwt()->>'sub' = user_id);

-- collection_items: owner-only, read + write.
create policy collection_select_own on public.collection_items
  for select using (auth.jwt()->>'sub' = user_id);
create policy collection_write_own on public.collection_items
  for all using (auth.jwt()->>'sub' = user_id)
          with check (auth.jwt()->>'sub' = user_id);

-- releases: world-readable (CC0). Writes only via service_role, which bypasses RLS,
-- so there is deliberately NO insert/update policy here.
create policy releases_public_read on public.releases
  for select using (true);

-- discogs_credentials: intentionally NO policies. Locked to service_role only.
