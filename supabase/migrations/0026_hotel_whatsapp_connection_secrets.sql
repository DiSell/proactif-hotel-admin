-- =========================================================================
-- Proactif System — hotel_whatsapp_connection_secrets: the encrypted
-- Meta Business Integration System User access token, ONE row per
-- hotel_whatsapp_connections row (0024). Additive only; 0024 and 0025 are
-- historical, already-applied migrations and are NOT edited by this file.
--
-- SCOPE: this migration stores CIPHERTEXT ONLY. It never encrypts or
-- decrypts anything itself — AES-256-GCM happens entirely in the Node
-- server process, with a key that lives ONLY in server environment
-- variables, never in this database. This migration receives bytes already
-- encrypted and hands back bytes still encrypted; no plaintext token,
-- authorization code, app secret, or encryption key is ever a parameter,
-- column, or return value anywhere in this file.
--
-- AUDIT PERFORMED BEFORE WRITING THIS MIGRATION:
--   - 0024_hotel_whatsapp_connections.sql: confirmed unique(id, hotel_id)
--     (the composite key this file's own tenant-safe FK depends on) and the
--     table's own "zero write grant for any role" discipline.
--   - 0025_hotel_whatsapp_connection_finalization.sql: confirmed the exact
--     signature/return shape of finalize_hotel_whatsapp_connection(), its
--     row-locking order (hotels, then the phone_number_id row), its
--     upsert-by-phone_number_id behavior, and its own reasoning for why
--     authorization here is enforced ENTIRELY by GRANT/REVOKE EXECUTE, never
--     an in-body identity check — the same reasoning is reused below.
--   - supabase/tests/hotel_whatsapp_connections_check.sql /
--     hotel_whatsapp_connection_finalization_check.sql: confirm the exact
--     grant/RLS shape already in place, which this migration must not
--     regress.
--   - public.set_updated_at() (0001_init.sql): reused verbatim, same
--     pattern as every other table in this schema.
--   - 0020_partner_requests.sql's own comment (section E) on why a
--     SECURITY DEFINER function calling ANOTHER SECURITY DEFINER function
--     that shares the same OWNER needs no additional grant: the callee's
--     EXECUTE privilege is checked against the CALLER's effective role,
--     which for a SECURITY DEFINER function is its OWNER for the entire
--     duration of the call — never the original external invoker. This is
--     the exact mechanism section 12 below relies on to revoke direct
--     external access to finalize_hotel_whatsapp_connection() while the new
--     composite function keeps calling it internally without any new grant.
--
-- WHY NO "status" COLUMN ON THIS TABLE (task section 4): the connection's
-- OWN business status already lives in hotel_whatsapp_connections.status —
-- duplicating a parallel active/revoked vocabulary here would create two
-- sources of truth that could drift. A secret that is no longer valid is
-- meant to be SUPPRESSED OR REPLACED (never flagged and kept) — minimizing
-- how many now-useless copies of a sensitive credential this database ever
-- retains. This migration does not implement that deletion/replacement
-- application flow (out of scope — see task section 21), only the storage
-- shape that makes it possible.
--
-- WHY key_id IS NEVER "CURRENT"/"PREVIOUS" (task section 6): those are
-- roles a Node-side key configuration assigns AT DECRYPTION TIME, not a
-- fact about the ciphertext itself. Persisting "CURRENT" would silently go
-- stale the moment a real key rotation promotes a new key to that role —
-- every already-encrypted row would then falsely claim to be decryptable
-- with the wrong key. key_id is an immutable version label instead (e.g.
-- "v1", "v2") identifying EXACTLY which key encrypted this exact row,
-- forever — the Node-side mapping of "which version is currently active"
-- is free to change without ever invalidating this column's meaning.
--
-- AAD CONTRACT (task section 7 — documented here for the NEXT task, NOT
-- implemented: no Node helper is written by this migration): the future
-- AES-256-GCM helper must use, as Additional Authenticated Data, the
-- deterministic UTF-8 string
--   `proactif-whatsapp-token:v{encryption_version}:{hotel_id}:{phone_number_id}`
-- — NEVER connection_id, which does not exist yet at encryption time (the
-- Node server encrypts the token BEFORE calling this migration's own
-- composite RPC, which is what first allocates/resolves connection_id).
-- hotel_id comes from requireClientAccess() server-side; phone_number_id is
-- the value already independently verified against Meta
-- (metaEmbeddedSignup.ts, a prior task). This database does not store the
-- AAD anywhere — the server reconstructs it identically at decryption time
-- from hotel_id + phone_number_id it already has from the connection row.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

-- =========================================================================
-- A. hotel_whatsapp_connection_secrets
-- =========================================================================
create table public.hotel_whatsapp_connection_secrets (
  id uuid primary key default gen_random_uuid(),

  connection_id uuid not null,
  hotel_id uuid not null,

  -- Already-encrypted bytes only — this column NEVER receives a plaintext
  -- token, and this migration never inspects its content beyond its raw
  -- length (task section 20: no "does this look like a token" check —
  -- that would be a false sense of security, not a real one).
  ciphertext bytea not null,
  -- AES-GCM nonce: exactly 12 bytes, unique per encryption operation —
  -- enforced structurally below, never validated for uniqueness here (that
  -- is the Node-side random generator's own responsibility).
  nonce bytea not null,
  -- AES-GCM authentication tag: exactly 16 bytes.
  auth_tag bytea not null,

  -- Immutable key-version label (task section 6) — NEVER "CURRENT"/
  -- "PREVIOUS". See this migration's own header comment.
  key_id text not null,
  encryption_version smallint not null default 1,

  obtained_at timestamptz not null default now(),
  last_rotated_at timestamptz,
  expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One live secret per connection — a rotation REPLACES this row's
  -- crypto columns in place (see finalize_hotel_whatsapp_connection_with_secret
  -- below), it never inserts a second row for the same connection_id.
  constraint hotel_whatsapp_connection_secrets_connection_id_key unique (connection_id),

  -- Tenant-safe composite FK (task section 3) — a secret can never
  -- reference a connection belonging to a DIFFERENT hotel_id; Postgres
  -- rejects it outright, independent of any application-level check. Never
  -- a plain FK on connection_id alone, which would not carry this
  -- guarantee. ON DELETE CASCADE mirrors 0024's own hotel_id FK: a deleted
  -- connection's secret is meaningless on its own and must go with it.
  constraint hotel_whatsapp_connection_secrets_connection_fk
    foreign key (connection_id, hotel_id) references public.hotel_whatsapp_connections (id, hotel_id) on delete cascade,

  -- Minimal structural/shape constraints only (task section 5) — no
  -- "resembles a real token" heuristic, ever. AES-256-GCM's own fixed
  -- primitive sizes are the only things checked: a 12-byte nonce and a
  -- 16-byte tag are properties of the ALGORITHM, not of any particular
  -- secret's content.
  constraint hotel_whatsapp_connection_secrets_ciphertext_not_empty check (octet_length(ciphertext) > 0),
  constraint hotel_whatsapp_connection_secrets_nonce_length check (octet_length(nonce) = 12),
  constraint hotel_whatsapp_connection_secrets_auth_tag_length check (octet_length(auth_tag) = 16),
  constraint hotel_whatsapp_connection_secrets_encryption_version_positive check (encryption_version > 0),
  constraint hotel_whatsapp_connection_secrets_key_id_not_empty check (btrim(key_id) <> ''),
  constraint hotel_whatsapp_connection_secrets_key_id_length check (char_length(key_id) <= 64)
);

comment on table public.hotel_whatsapp_connection_secrets is
  'Encrypted Meta Business Integration System User access token, one row per hotel_whatsapp_connections row. Stores ciphertext/nonce/auth_tag ONLY — this database never encrypts, decrypts, or inspects the plaintext. No status column: the connection''s own status (hotel_whatsapp_connections.status) is the single source of truth for whether it is usable; a no-longer-valid secret is meant to be replaced or deleted, never flagged and kept. Write-locked for every role, including service_role — the only write path is finalize_hotel_whatsapp_connection_with_secret() below; the only read path is get_hotel_whatsapp_connection_secret() below.';

comment on column public.hotel_whatsapp_connection_secrets.key_id is
  'Immutable label identifying EXACTLY which encryption key produced this row''s ciphertext (e.g. "v1", "v2") — never "CURRENT"/"PREVIOUS", which are roles the Node-side key configuration assigns at decryption time, not a persisted fact. See this migration''s own header comment.';

comment on column public.hotel_whatsapp_connection_secrets.nonce is
  'AES-GCM nonce, exactly 12 bytes, unique per encryption operation (Node-side responsibility — this column only enforces the fixed length, never uniqueness or randomness).';

comment on column public.hotel_whatsapp_connection_secrets.auth_tag is
  'AES-GCM authentication tag, exactly 16 bytes.';

create index hotel_whatsapp_connection_secrets_hotel_id_idx on public.hotel_whatsapp_connection_secrets (hotel_id);

create trigger set_updated_at before update on public.hotel_whatsapp_connection_secrets
  for each row execute function public.set_updated_at();

-- =========================================================================
-- B. RLS + grants (task section 8) — deliberately STRICTER than 0024: even
-- service_role has ZERO direct privilege on this table. Every legitimate
-- read or write goes through one of the two SECURITY DEFINER functions
-- below, which are themselves reachable only by service_role (and, for
-- finalize_hotel_whatsapp_connection_with_secret, are the ONLY way to reach
-- a hotel_whatsapp_connections row that is both active AND has a secret —
-- see section D).
-- =========================================================================
alter table public.hotel_whatsapp_connection_secrets enable row level security;

-- No policy of any kind is created — RLS enabled with zero policies denies
-- every row to every role by default, on top of the explicit revokes below
-- (belt and suspenders: Supabase-managed schemas commonly grant default
-- privileges to anon/authenticated/service_role on newly created tables,
-- exactly why 0020/0023/0024 each revoke explicitly right after CREATE
-- TABLE too, rather than assuming a blank slate).
revoke select, insert, update, delete on public.hotel_whatsapp_connection_secrets from public;
revoke select, insert, update, delete on public.hotel_whatsapp_connection_secrets from anon;
revoke select, insert, update, delete on public.hotel_whatsapp_connection_secrets from authenticated;
revoke select, insert, update, delete on public.hotel_whatsapp_connection_secrets from service_role;

-- =========================================================================
-- C. Harden 0025 (task section 12 — POINT CRITIQUE): revoke DIRECT external
-- EXECUTE on finalize_hotel_whatsapp_connection() from every role,
-- INCLUDING service_role. 0025's own file is NOT edited — this is a plain
-- REVOKE statement against an already-existing function, issued from a
-- later migration, exactly as safe and additive as 0023's own extension of
-- 0020's apply_partner_request_command() (there via create-or-replace; here
-- an even lighter touch, since no redefinition is needed at all).
--
-- After this, ONLY finalize_hotel_whatsapp_connection_with_secret() below
-- can still reach it — internally, as a plain SQL call from within its own
-- SECURITY DEFINER body. That internal call is authorized NOT by any grant
-- added here, but because a SECURITY DEFINER function executes as its
-- OWNER for its entire duration (see this migration's own header comment,
-- citing 0020's identical reasoning for is_superadmin()/is_hotel_admin_for()):
-- since both functions share the same owner (whichever role applies these
-- migrations), the owner's own inherent privilege on its own function is
-- untouched by revoking OTHER roles' grants. No new grant is required or
-- added for this internal call.
-- =========================================================================
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from public;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from anon;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from authenticated;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from service_role;

-- =========================================================================
-- D. finalize_hotel_whatsapp_connection_with_secret — the ONLY externally
-- callable way to reach an active hotel_whatsapp_connections row from now
-- on (task section 9/10). Wraps 0025's own function as an internal call so
-- that the connection write and the secret write share ONE Postgres
-- transaction: any failure writing the secret (including a CHECK
-- constraint violation on ciphertext/nonce/auth_tag/key_id/encryption_version
-- shape) raises an uncaught exception here, which rolls back EVERYTHING
-- this function did in this call — including the nested
-- finalize_hotel_whatsapp_connection() write — automatically, by ordinary
-- PL/pgSQL/transaction semantics. It must never be possible for this RPC
-- to leave behind an active connection with no secret, or a secret with no
-- corresponding connection.
--
-- Never accepts, and never will: a plaintext token, an authorization code,
-- an app secret, or an encryption key (task section 9's own explicit list).
-- =========================================================================
create or replace function public.finalize_hotel_whatsapp_connection_with_secret(
  p_hotel_id uuid,
  p_waba_id text,
  p_phone_number_id text,
  p_business_id text,
  p_connection_type text,
  p_ciphertext bytea,
  p_nonce bytea,
  p_auth_tag bytea,
  p_key_id text,
  p_encryption_version smallint,
  p_expires_at timestamptz
) returns table (
  id uuid,
  hotel_id uuid,
  waba_id text,
  phone_number_id text,
  business_id text,
  connection_type text,
  status text,
  is_primary boolean,
  connected_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection record;
  v_existing_secret_id uuid;
  v_existing_obtained_at timestamptz;
  v_result_secret_id uuid;
begin
  -- Step 1 (task section 10.1/10.2): finalize connection metadata via the
  -- EXISTING, unmodified 0025 primitive, called internally — not a second
  -- round-trip from Node. v_connection.id is the REAL, server-resolved
  -- connection_id; never accepted as a parameter of this function.
  select * into v_connection
  from public.finalize_hotel_whatsapp_connection(p_hotel_id, p_waba_id, p_phone_number_id, p_business_id, p_connection_type);

  -- Step 2 (task section 10.3, 11): lock any pre-existing secret for this
  -- EXACT connection_id — same row-lock-before-decision discipline as
  -- 0025's own hotel/phone_number_id locks.
  select s.id, s.obtained_at
  into v_existing_secret_id, v_existing_obtained_at
  from public.hotel_whatsapp_connection_secrets s
  where s.connection_id = v_connection.id
  for update;

  -- obtained_at: now() only on a genuine first storage; preserved across a
  -- rotation (task section 11). last_rotated_at: null on first storage,
  -- now() on every subsequent replacement.
  insert into public.hotel_whatsapp_connection_secrets (
    connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version,
    obtained_at, last_rotated_at, expires_at
  ) values (
    v_connection.id, p_hotel_id, p_ciphertext, p_nonce, p_auth_tag, p_key_id, p_encryption_version,
    coalesce(v_existing_obtained_at, now()),
    case when v_existing_secret_id is null then null else now() end,
    p_expires_at
  )
  on conflict (connection_id) do update
  set ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      auth_tag = excluded.auth_tag,
      key_id = excluded.key_id,
      encryption_version = excluded.encryption_version,
      expires_at = excluded.expires_at,
      last_rotated_at = now()
  -- Second, independent tenant-safety layer (same discipline as 0025's own
  -- upsert WHERE clause) — never the ONLY thing preventing a cross-tenant
  -- write; the composite FK above and 0025's own explicit lock-and-check
  -- are what actually guarantee it.
  where public.hotel_whatsapp_connection_secrets.hotel_id = excluded.hotel_id
  returning public.hotel_whatsapp_connection_secrets.id into v_result_secret_id;

  if v_result_secret_id is null then
    raise exception 'phone_number_cross_tenant' using errcode = 'P0001';
  end if;

  -- Step 3 (task section 16): return ONLY non-secret connection metadata —
  -- never ciphertext/nonce/auth_tag/key_id, from this function, ever.
  return query
  select v_connection.id, v_connection.hotel_id, v_connection.waba_id, v_connection.phone_number_id,
         v_connection.business_id, v_connection.connection_type, v_connection.status, v_connection.is_primary,
         v_connection.connected_at;
end;
$$;

comment on function public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz) is
  'The ONLY externally-reachable way to finalize a hotel_whatsapp_connections row as active, and the ONLY way to write hotel_whatsapp_connection_secrets. Wraps finalize_hotel_whatsapp_connection() (0025, unmodified) as an internal call so both writes share one transaction — a secret write failure rolls back the connection write too. Never accepts a plaintext token/authorization code/app secret/encryption key. Returns non-secret connection metadata only.';

revoke execute on function public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz) from public;
revoke execute on function public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz) from anon;
revoke execute on function public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz) from authenticated;
grant execute on function public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz) to service_role;

-- =========================================================================
-- E. get_hotel_whatsapp_connection_secret — the ONLY read path onto
-- hotel_whatsapp_connection_secrets (task section 14). Returns
-- crypto material only, never a decrypted value (decryption happens
-- entirely in Node, with a key this database never holds). Requires the
-- JOINED connection to be status = 'active' — a pending/error/revoked
-- connection's secret (if one somehow still exists) is never handed out.
-- Returns zero rows, never an exception, when no matching active secret
-- exists — a plain filtered read, unlike the mutating functions above
-- which use exceptions for invalid states.
-- =========================================================================
create or replace function public.get_hotel_whatsapp_connection_secret(
  p_connection_id uuid,
  p_hotel_id uuid
) returns table (
  connection_id uuid,
  hotel_id uuid,
  ciphertext bytea,
  nonce bytea,
  auth_tag bytea,
  key_id text,
  encryption_version smallint,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select s.connection_id, s.hotel_id, s.ciphertext, s.nonce, s.auth_tag, s.key_id, s.encryption_version, s.expires_at
  from public.hotel_whatsapp_connection_secrets s
  join public.hotel_whatsapp_connections c
    on c.id = s.connection_id and c.hotel_id = s.hotel_id
  where s.connection_id = p_connection_id
    and s.hotel_id = p_hotel_id
    and c.status = 'active';
end;
$$;

comment on function public.get_hotel_whatsapp_connection_secret(uuid, uuid) is
  'The ONLY read path onto hotel_whatsapp_connection_secrets. Returns crypto material only (ciphertext/nonce/auth_tag/key_id/encryption_version/expires_at) for a connection whose JOINED hotel_whatsapp_connections.status is active — never a plaintext token, never a decrypted value, never a key. Zero rows, not an exception, when nothing matches.';

revoke execute on function public.get_hotel_whatsapp_connection_secret(uuid, uuid) from public;
revoke execute on function public.get_hotel_whatsapp_connection_secret(uuid, uuid) from anon;
revoke execute on function public.get_hotel_whatsapp_connection_secret(uuid, uuid) from authenticated;
grant execute on function public.get_hotel_whatsapp_connection_secret(uuid, uuid) to service_role;
