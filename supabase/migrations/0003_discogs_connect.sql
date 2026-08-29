-- 0003_discogs_connect.sql — Phase 1 Stage B
--
-- PART 1: OAuth handshake state.
--
-- OAuth 1.0a is a two-leg handshake. Leg 1 gets a request token from Discogs and sends the
-- user away to authorize. Leg 2 is a browser redirect BACK from Discogs carrying the request
-- token and a verifier -- with no Authorization header, because a redirect cannot have one.
-- So leg 2 must answer "who is this?" from the request token alone. This table is that
-- answer: it binds the unguessable request token to the Clerk user id that started the flow.
--
-- RLS ON with ZERO POLICIES, exactly like discogs_credentials: service_role only. The
-- oauth_token_secret stored here is a credential.
--
-- Discogs expires request tokens after 15 minutes, so expires_at makes that explicit and
-- lets the callback reject a stale handshake instead of forwarding a doomed request.

create table if not exists public.discogs_oauth_state (
  oauth_token         text primary key,
  oauth_token_secret  text not null,
  user_id             text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '15 minutes')
);

create index if not exists discogs_oauth_state_expires_idx
  on public.discogs_oauth_state (expires_at);

alter table public.discogs_oauth_state enable row level security;
-- Intentionally NO policies. service_role only.

-- PART 2: atomic account linking.
--
-- Linking touches two tables. Doing it as two PostgREST calls can leave an encrypted
-- credential orphaned when the profile write fails -- and it WILL fail: profiles has a
-- unique index on lower(discogs_username) (migration 0002), so a second Clerk account
-- connecting the same Discogs handle raises 23505. One function, one transaction, so either
-- both writes land or neither does.
--
-- SECURITY DEFINER because it writes discogs_credentials, which has no policies. It is
-- callable only by the service_role (see the revoke/grant below), so no client can reach it.

create or replace function public.link_discogs_account(
  p_user_id      text,
  p_username     text,
  p_token_enc    text,
  p_secret_enc   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set discogs_username     = p_username,
         discogs_connected_at = now()
   where user_id = p_user_id;

  if not found then
    raise exception 'no profile for user_id %', p_user_id
      using errcode = 'P0002';   -- no_data_found
  end if;

  insert into public.discogs_credentials (user_id, oauth_token, oauth_token_secret)
       values (p_user_id, p_token_enc, p_secret_enc)
  on conflict (user_id) do update
          set oauth_token        = excluded.oauth_token,
              oauth_token_secret = excluded.oauth_token_secret;
end;
$$;

revoke all on function public.link_discogs_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_discogs_account(text, text, text, text) to service_role;
