-- =========================================================================
-- Proactif System — fixes a SECOND, real column-ambiguity bug (Postgres
-- 42702) in the deployed finalize_hotel_whatsapp_connection(), surfaced
-- only AFTER 0027's own fix was applied and exercised through
-- finalize_hotel_whatsapp_connection_with_secret() (0026):
--
--   ERROR:  42702: column reference "phone_number_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   QUERY:  insert into public.hotel_whatsapp_connections as hwc (...)
--           values (...)
--           on conflict (phone_number_id) do update
--           set ...
--
-- ROOT CAUSE (different mechanism than 0027's fix, despite looking similar):
-- an `INSERT ... (column_list)` target list and an `UPDATE/DO UPDATE SET
-- column = ...` assignment target are ALWAYS resolved directly against the
-- target relation's own columns by the parser — they are simple identifier
-- lists, never expressions, so PL/pgSQL's variable-shadowing never applies
-- there (confirmed empirically: 0027's rewrite left the INSERT column list
-- and every `SET x = ...` target unaliased and unqualified, and none of
-- them raised anything).
--
-- `ON CONFLICT (conflict_target)` is DIFFERENT: PostgreSQL supports
-- expression and partial-index arbiters there (e.g.
-- `ON CONFLICT (lower(email))`), so each element of the conflict target
-- list is parsed as a general EXPRESSION, not a plain column identifier —
-- which means it DOES go through the same generic column-reference
-- resolution PL/pgSQL hooks into for ordinary WHERE/SELECT expressions.
-- Since `phone_number_id` is also one of this function's own
-- `RETURNS TABLE` output names (implicitly an in-scope PL/pgSQL variable
-- for the whole function body, exactly like `id` was in 0027's bug), the
-- bare `ON CONFLICT (phone_number_id)` is ambiguous the same way
-- `WHERE id = ...` was — just via a different grammar path that 0027's own
-- audit incorrectly assumed was immune (target lists such as INSERT
-- columns and UPDATE SET targets genuinely are immune; conflict targets
-- are not, because they are expressions).
--
-- THE FIX: `ON CONFLICT (conflict_target)` syntax has no way to
-- table-qualify a bare column name (`ON CONFLICT (hwc.phone_number_id)` is
-- not valid PostgreSQL syntax) — so aliasing, which fixed every other spot
-- in 0027, cannot fix this one. The correct, standard alternative is
-- `ON CONFLICT ON CONSTRAINT <constraint_name>`, which identifies the
-- arbiter by its NAME instead of by a column expression — a constraint
-- name is never subject to PL/pgSQL variable resolution (it isn't a column
-- reference at all), so this is immune to this entire bug class by
-- construction. The exact constraint targeted is
-- `hotel_whatsapp_connections_phone_number_id_key`
-- (`unique (phone_number_id)`, declared in 0024_hotel_whatsapp_connections.sql
-- and never touched since) — this migration does not create, rename, or
-- alter that constraint in any way, it only references it by its existing
-- name.
--
-- 0024, 0025, 0026 AND 0027 are historical, already-applied migrations and
-- are NOT edited by this file. This migration ONLY replaces the function
-- body again via `create or replace function`, with the IDENTICAL
-- signature, RETURNS TABLE shape, SECURITY DEFINER, and business logic as
-- 0027 left it — the sole change is the `ON CONFLICT` clause's own target
-- specification. Every other line is byte-for-byte the same as 0027's
-- version (including the `hwc`/`h`/`c` aliasing that migration already
-- introduced correctly).
--
-- GRANTS: identical reasoning as 0027's own migration — CREATE OR REPLACE
-- FUNCTION preserves the function's existing ACL when its argument types
-- are unchanged, so 0026's hardening (service_role has no direct EXECUTE)
-- is not undone by this replacement. Every REVOKE is restated explicitly
-- below anyway, for the same self-containment reason as 0027. No GRANT
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
  -- Aliased `h` — fixed by 0027, unchanged here.
  -- =======================================================================
  perform 1 from public.hotels h where h.id = p_hotel_id for update;
  if not found then
    raise exception 'hotel_not_found' using errcode = 'P0002';
  end if;

  -- =======================================================================
  -- Cross-tenant protection (task section 6 — POINT CRITIQUE). Looked up
  -- and LOCKED explicitly, by phone_number_id alone (its uniqueness is
  -- GLOBAL, never scoped to a hotel — 0024's own constraint), before any
  -- upsert is attempted. Already alias-qualified (`c.`) — unchanged.
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
  -- the hotel row lock taken above. Already alias-qualified (`c.`) —
  -- unchanged.
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
  -- Upsert (task sections 7/9/14). status is ALWAYS 'active' here.
  --
  -- FIX (this migration): the arbiter is now identified BY CONSTRAINT NAME
  -- (`on conflict on constraint hotel_whatsapp_connections_phone_number_id_key`)
  -- instead of by the bare column list `on conflict (phone_number_id)` —
  -- the latter is parsed as an EXPRESSION (PostgreSQL allows expression/
  -- partial-index arbiters), which routes it through the same
  -- PL/pgSQL variable-resolution hook as any WHERE/SELECT expression;
  -- since `phone_number_id` is also this function's own RETURNS TABLE
  -- output name, that bare form was ambiguous (42702) — see this
  -- migration's own header comment. A constraint name is never a column
  -- reference, so this form is immune to this entire bug class.
  --
  -- The INSERT's own column list and every `SET x = ...` target below
  -- remain unaliased and unqualified on purpose — both are genuinely safe
  -- (plain identifier lists resolved directly against the target relation,
  -- never expressions), confirmed by the fact that neither ever raised
  -- 42702 even before this fix.
  --
  -- The `where hwc.hotel_id = excluded.hotel_id` / `returning hwc.id`
  -- clauses (aliased `hwc` since 0027) are unchanged — a SECOND,
  -- independent layer of cross-tenant protection, never the ONLY one (task
  -- section 6's own explicit warning: a false WHERE here could otherwise
  -- silently produce a zero-row update instead of a clear error); the
  -- `if v_result_id is null` guard below still turns that silent zero-row
  -- outcome into the same explicit phone_number_cross_tenant exception.
  -- =======================================================================
  insert into public.hotel_whatsapp_connections as hwc (
    hotel_id, waba_id, phone_number_id, business_id, connection_type, status,
    is_primary, connected_at, disconnected_at, last_error_code
  ) values (
    p_hotel_id, p_waba_id, p_phone_number_id, p_business_id, p_connection_type, 'active',
    v_new_is_primary, v_new_connected_at, null, null
  )
  on conflict on constraint hotel_whatsapp_connections_phone_number_id_key do update
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

  -- Already alias-qualified (`c.`) — unchanged.
  return query
  select c.id, c.hotel_id, c.waba_id, c.phone_number_id, c.business_id, c.connection_type, c.status, c.is_primary, c.connected_at
  from public.hotel_whatsapp_connections c
  where c.id = v_result_id;
end;
$$;

comment on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) is
  'The ONLY write path onto hotel_whatsapp_connections (0024). Represents a connection ALREADY validated server-side against Meta by the caller — always writes status = ''active'', never accepts a caller-supplied status. SECURITY DEFINER; authorization is enforced ENTIRELY by the EXECUTE grant below (service_role has none directly — see 0026 — only the internal call from finalize_hotel_whatsapp_connection_with_secret() reaches it), never by an in-body current_user/auth.jwt() check. Never receives a token/code/secret/human phone number; never persists one. Body replaced by 0027 to fix a WHERE-clause column-ambiguity bug (42702, hotels lock), then again by 0028 to fix a SECOND, different-mechanism ambiguity in the ON CONFLICT target list (also 42702, phone_number_id) — see each migration''s own header comment.';

-- =========================================================================
-- Authorization (unchanged from 0025/0026/0027): EXECUTE restricted to
-- service_role has none directly (0026's hardening); restated explicitly
-- here for self-containment (idempotent; CREATE OR REPLACE FUNCTION does
-- not reset an unchanged-signature function's ACL on its own). NO grant to
-- service_role appears anywhere in this file.
-- =========================================================================
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from public;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from anon;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from authenticated;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from service_role;
