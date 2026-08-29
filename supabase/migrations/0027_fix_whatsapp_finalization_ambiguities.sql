-- =========================================================================
-- Proactif System — fixes a REAL bug found in the DEPLOYED
-- finalize_hotel_whatsapp_connection() (0025): a column-ambiguity error
-- (Postgres 42702) surfaced when calling it through
-- finalize_hotel_whatsapp_connection_with_secret() (0026):
--
--   ERROR:  column reference "id" is ambiguous
--   QUERY:  SELECT 1 FROM public.hotels WHERE id = p_hotel_id FOR UPDATE
--
-- ROOT CAUSE: finalize_hotel_whatsapp_connection() is declared
-- `RETURNS TABLE (id uuid, hotel_id uuid, waba_id text, phone_number_id
-- text, business_id text, connection_type text, status text, is_primary
-- boolean, connected_at timestamptz)`. PL/pgSQL implicitly declares EACH of
-- those OUT-parameter names as an in-scope variable for the ENTIRE function
-- body. `perform 1 from public.hotels where id = p_hotel_id for update;`
-- gives `public.hotels` no alias, so the bare identifier `id` inside that
-- embedded SQL statement is ambiguous between hotels.id (the table column)
-- and the function's own `id` OUT parameter — Postgres correctly refuses to
-- guess and raises 42702.
--
-- 0024/0025/0026 are historical, already-applied migrations and are NOT
-- edited by this file. This migration ONLY replaces the function body via
-- `create or replace function` with the IDENTICAL signature, RETURNS TABLE
-- shape, SECURITY DEFINER, and business logic — the sole change is SQL
-- identifier resolution: every table reference now carries an explicit
-- alias, and every column reference inside an expression context is
-- qualified by that alias.
--
-- FULL AUDIT OF THE DEPLOYED FUNCTION FOR EVERY OUT-PARAMETER NAME
-- (id, hotel_id, waba_id, phone_number_id, business_id, connection_type,
-- status, is_primary, connected_at) — per this task's own requirement to
-- never fix only `id`:
--   - `perform 1 from public.hotels where id = p_hotel_id for update;`
--     -> GENUINE BUG (the one that surfaced). Fixed by aliasing:
--     `public.hotels h ... where h.id = p_hotel_id`.
--   - `select c.id, c.hotel_id, c.status, c.is_primary, c.connected_at
--     into ... from public.hotel_whatsapp_connections c where
--     c.phone_number_id = p_phone_number_id for update;` -> already
--     alias-qualified throughout (`c.`), NOT ambiguous. Kept as-is.
--   - The `exists(select 1 from public.hotel_whatsapp_connections c where
--     c.hotel_id = ... and c.status = ... and c.is_primary = ... and c.id
--     is distinct from ...)` subquery -> already alias-qualified
--     throughout, NOT ambiguous. Kept as-is.
--   - `insert into public.hotel_whatsapp_connections (hotel_id, waba_id,
--     phone_number_id, business_id, connection_type, status, is_primary,
--     connected_at, disconnected_at, last_error_code) values (...)` -> the
--     column list of an INSERT target is ALWAYS resolved against the
--     target table's own columns by SQL grammar, never against a
--     PL/pgSQL variable in scope — NOT ambiguous, regardless of aliasing.
--     Kept as-is.
--   - `on conflict (phone_number_id) do update set waba_id = ...,
--     business_id = ..., connection_type = ..., status = 'active',
--     is_primary = ..., connected_at = ..., disconnected_at = null,
--     last_error_code = null` -> the left-hand side of each `SET col =`
--     assignment is likewise ALWAYS a target-table column reference by SQL
--     grammar, never ambiguous; every right-hand side is either a literal
--     or already qualified via `excluded.` -- NOT ambiguous. Still
--     rewritten below to use an explicit `AS hwc` alias for the target row
--     (replacing the previous `public.hotel_whatsapp_connections.hotel_id`
--     repetition) purely for consistency/readability, not because it was
--     broken.
--   - `where public.hotel_whatsapp_connections.hotel_id = excluded.hotel_id
--     returning public.hotel_whatsapp_connections.id into v_result_id;`
--     -> already fully schema-and-table qualified (not a bare identifier),
--     NOT ambiguous; rewritten to use the new `hwc.` alias instead of
--     repeating the full table name, for consistency only.
--   - The final `return query select c.id, c.hotel_id, c.waba_id,
--     c.phone_number_id, c.business_id, c.connection_type, c.status,
--     c.is_primary, c.connected_at from public.hotel_whatsapp_connections c
--     where c.id = v_result_id;` -> already alias-qualified throughout, NOT
--     ambiguous. Kept as-is.
--
-- CONCLUSION: exactly ONE genuine ambiguity existed (the `hotels` lock at
-- the very top of the function, which is also the one Postgres actually
-- raised). Every other reference was already either alias-qualified or in
-- a grammatical position immune to PL/pgSQL variable shadowing. This
-- migration still applies an explicit alias EVERYWHERE (hotels AS h,
-- hotel_whatsapp_connections AS hwc for the insert/upsert, `c` kept for the
-- two pre-existing SELECT statements) so that no future OUT-parameter
-- rename can silently reintroduce this class of bug anywhere in this
-- function.
--
-- NOTHING ELSE CHANGES: identical signature
-- (uuid, text, text, text, text), identical RETURNS TABLE shape, identical
-- SECURITY DEFINER + SET search_path = public, identical validation order,
-- identical hotel row lock, identical phone_number_id row lock, identical
-- cross-tenant rejection, identical is_primary decision, identical
-- connected_at coalesce, identical upsert columns, identical error
-- messages/errcodes, identical return shape. finalize_hotel_whatsapp_connection_with_secret()
-- (0026) keeps calling this function internally by name/signature — a
-- `create or replace function` with an unchanged signature updates the
-- function in place (Postgres invalidates and rebuilds any cached plan
-- that depends on it), so 0026 requires no change at all.
--
-- GRANTS (task section 6): CREATE OR REPLACE FUNCTION preserves the
-- function's existing ACL when its argument types are unchanged, so 0026's
-- own hardening (revoking EXECUTE from service_role too) is NOT undone by
-- this replacement on its own. This migration nonetheless RESTATES every
-- REVOKE explicitly (public/anon/authenticated/service_role) — idempotent,
-- changes nothing if already correct, and makes this file self-contained
-- proof that it never re-grants EXECUTE to service_role. No GRANT
-- statement for service_role appears anywhere in this file.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

create or replace function public.finalize_hotel_whatsapp_connection(
  p_hotel_id uuid,
  p_waba_id text,
  p_phone_number_id text,
  p_business_id text,
  p_connection_type text
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
  v_existing_id uuid;
  v_existing_hotel_id uuid;
  v_existing_status text;
  v_existing_is_primary boolean;
  v_existing_connected_at timestamptz;
  v_other_primary_exists boolean;
  v_new_is_primary boolean;
  v_new_connected_at timestamptz;
  v_result_id uuid;
begin
  -- =======================================================================
  -- Parameter validation (task section 4). This function performs NO Meta
  -- validation of its own — only shape/presence checks. Deterministic,
  -- closed error identifiers only (task section 13), never a secret or PII
  -- in any message.
  -- =======================================================================
  if p_hotel_id is null then
    raise exception 'hotel_not_found' using errcode = 'P0002';
  end if;
  if p_waba_id is null or btrim(p_waba_id) = '' then
    raise exception 'invalid_waba_id' using errcode = 'P0001';
  end if;
  if p_phone_number_id is null or btrim(p_phone_number_id) = '' then
    raise exception 'invalid_phone_number_id' using errcode = 'P0001';
  end if;
  if p_connection_type not in ('coexistence', 'cloud_api_only') then
    raise exception 'invalid_connection_type' using errcode = 'P0001';
  end if;
  -- p_business_id is intentionally NOT validated for presence (task section
  -- 10): null is an accepted, legitimate value.

  -- =======================================================================
  -- Lock the hotel row (task section 5) BEFORE any is_primary decision.
  -- FIX (this migration): `public.hotels` now carries the explicit alias
  -- `h`, and the lock condition is `h.id = p_hotel_id` — the deployed 0025
  -- body left `public.hotels` unaliased and wrote `where id = p_hotel_id`,
  -- which Postgres correctly rejected as ambiguous against this function's
  -- own `id` OUT parameter (42702). Two concurrent finalize calls for the
  -- SAME hotel still serialize here exactly as before: the second waits
  -- for the first transaction to commit (or roll back) before proceeding,
  -- so the "does an active+primary row already exist for this hotel" read
  -- below can never observe a stale/racing answer.
  -- =======================================================================
  perform 1 from public.hotels h where h.id = p_hotel_id for update;
  if not found then
    raise exception 'hotel_not_found' using errcode = 'P0002';
  end if;

  -- =======================================================================
  -- Cross-tenant protection (task section 6 — POINT CRITIQUE). Looked up
  -- and LOCKED explicitly, by phone_number_id alone (its uniqueness is
  -- GLOBAL, never scoped to a hotel — 0024's own constraint), before any
  -- upsert is attempted. A row belonging to a DIFFERENT hotel raises here,
  -- immediately — the ON CONFLICT clause on the upsert below is deliberately
  -- NOT the only thing standing between this function and a cross-tenant
  -- write (see the comment above the upsert for the second, independent
  -- layer this task's own instructions required). Already alias-qualified
  -- in the deployed 0025 body (`c.`) — unchanged here.
  -- =======================================================================
  select c.id, c.hotel_id, c.status, c.is_primary, c.connected_at
  into v_existing_id, v_existing_hotel_id, v_existing_status, v_existing_is_primary, v_existing_connected_at
  from public.hotel_whatsapp_connections c
  where c.phone_number_id = p_phone_number_id
  for update;

  if found and v_existing_hotel_id <> p_hotel_id then
    raise exception 'phone_number_cross_tenant' using errcode = 'P0001';
  end if;

  -- =======================================================================
  -- is_primary decision (task section 8) — computed BEFORE the write, under
  -- the hotel row lock taken above:
  --   - an existing row for this SAME hotel that is already active+primary
  --     stays primary, unconditionally (never arbitrarily demoted here);
  --   - otherwise, this connection becomes primary ONLY if the hotel
  --     currently has no OTHER active+primary connection.
  -- Already alias-qualified in the deployed 0025 body (`c.`) — unchanged.
  -- =======================================================================
  if found and v_existing_status = 'active' and v_existing_is_primary then
    v_new_is_primary := true;
  else
    select exists (
      select 1
      from public.hotel_whatsapp_connections c
      where c.hotel_id = p_hotel_id
        and c.status = 'active'
        and c.is_primary = true
        and c.id is distinct from v_existing_id
    ) into v_other_primary_exists;
    v_new_is_primary := not v_other_primary_exists;
  end if;

  -- connected_at (task section 11): preserved across an idempotent retry on
  -- an already-known row, set to now() only for a genuinely first activation.
  v_new_connected_at := coalesce(v_existing_connected_at, now());

  -- =======================================================================
  -- Upsert (task sections 7/9/14). status is ALWAYS 'active' here — this
  -- function represents an already-server-validated finalization only; it
  -- never accepts a caller-supplied status and never produces pending/
  -- error/revoked (task section 9). disconnected_at/last_error_code are
  -- always cleared on a (re-)finalization.
  --
  -- The INSERT's own column list, and the left-hand side of every
  -- `DO UPDATE SET column = ...` assignment, are ALWAYS resolved against
  -- the target table by SQL grammar — never ambiguous against a PL/pgSQL
  -- variable, with or without an alias. The target row is still given the
  -- explicit alias `hwc` (task section 4/5) so the WHERE and RETURNING
  -- clauses below read as ordinary alias-qualified references instead of
  -- repeating the full table name (the deployed 0025 body's
  -- `public.hotel_whatsapp_connections.hotel_id`/`...id` form was already
  -- unambiguous, just more verbose than necessary).
  --
  -- The `where hwc.hotel_id = excluded.hotel_id` clause is a SECOND,
  -- independent layer of cross-tenant protection, never the ONLY one (task
  -- section 6's own explicit warning: a false WHERE here could otherwise
  -- silently produce a zero-row update instead of a clear error) — the
  -- explicit lock-and-check above is what actually guarantees a
  -- cross-tenant attempt is rejected LOUDLY; this WHERE only guards the
  -- narrow window where two brand-new inserts for the SAME
  -- not-yet-existing phone_number_id race each other (neither sees a row
  -- to lock above, since neither has been committed yet) — in that case
  -- Postgres serializes the two INSERTs, the loser's ON CONFLICT branch
  -- evaluates against the winner's now-committed row, this WHERE clause
  -- correctly refuses to touch it, and the `if v_result_id is null` guard
  -- immediately below turns that silent zero-row outcome into the same
  -- explicit phone_number_cross_tenant exception — the other hotel's row
  -- is never modified in either path.
  -- =======================================================================
  insert into public.hotel_whatsapp_connections as hwc (
    hotel_id, waba_id, phone_number_id, business_id, connection_type, status,
    is_primary, connected_at, disconnected_at, last_error_code
  ) values (
    p_hotel_id, p_waba_id, p_phone_number_id, p_business_id, p_connection_type, 'active',
    v_new_is_primary, v_new_connected_at, null, null
  )
  on conflict (phone_number_id) do update
  set waba_id = excluded.waba_id,
      business_id = excluded.business_id,
      connection_type = excluded.connection_type,
      status = 'active',
      is_primary = excluded.is_primary,
      connected_at = excluded.connected_at,
      disconnected_at = null,
      last_error_code = null
  where hwc.hotel_id = excluded.hotel_id
  returning hwc.id into v_result_id;

  if v_result_id is null then
    raise exception 'phone_number_cross_tenant' using errcode = 'P0001';
  end if;

  -- Already alias-qualified in the deployed 0025 body (`c.`) — unchanged.
  return query
  select c.id, c.hotel_id, c.waba_id, c.phone_number_id, c.business_id, c.connection_type, c.status, c.is_primary, c.connected_at
  from public.hotel_whatsapp_connections c
  where c.id = v_result_id;
end;
$$;

comment on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) is
  'The ONLY write path onto hotel_whatsapp_connections (0024). Represents a connection ALREADY validated server-side against Meta by the caller — always writes status = ''active'', never accepts a caller-supplied status. SECURITY DEFINER; authorization is enforced ENTIRELY by the EXECUTE grant below (service_role has none directly — see 0026 — only the internal call from finalize_hotel_whatsapp_connection_with_secret() reaches it), never by an in-body current_user/auth.jwt() check. Never receives a token/code/secret/human phone number; never persists one. Body replaced by 0027 solely to fix a column-ambiguity bug (42702) between this function''s own RETURNS TABLE names and unaliased table references — see that migration''s own header comment.';

-- =========================================================================
-- Authorization (unchanged from 0025/0026): EXECUTE restricted to
-- service_role ONLY at the table-grant level from 0025's own perspective —
-- and 0026 already further revoked it from service_role too, since the
-- hardened entry point is finalize_hotel_whatsapp_connection_with_secret().
-- Restated explicitly here for self-containment (idempotent; CREATE OR
-- REPLACE FUNCTION does not reset an unchanged-signature function's ACL on
-- its own, so this is redundant with what's already in place — never a
-- widening). NO grant to service_role appears anywhere in this file.
-- =========================================================================
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from public;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from anon;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from authenticated;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from service_role;
