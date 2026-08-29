-- =========================================================================
-- Proactif System — finalize_hotel_whatsapp_connection: the ONE and ONLY
-- write path onto public.hotel_whatsapp_connections (0024). 0024 itself
-- revokes INSERT/UPDATE/DELETE from every role, including service_role —
-- this migration adds the single SECURITY DEFINER primitive that fills that
-- gap, and nothing else. Additive only; 0024 is NOT modified.
--
-- SCOPE: PostgreSQL/RPC layer ONLY. This migration does not call Meta, does
-- not know what a WABA or an access token is beyond an opaque text id, and
-- is not yet wired to any application code — receiveWhatsAppEmbeddedSignupCode()
-- (src/features/whatsappIntegration/actions.ts) still stops before any
-- database write; connecting it to this RPC is explicitly a LATER task.
-- Every id this function receives (p_hotel_id, p_waba_id, p_phone_number_id,
-- p_business_id) is assumed ALREADY validated by the caller against Meta —
-- this function performs zero Meta-shaped validation of its own, only
-- referential/tenant/shape checks over already-vetted values.
--
-- AUDIT PERFORMED BEFORE WRITING THIS FUNCTION (per this task's own
-- requirement):
--   - 0024_hotel_whatsapp_connections.sql: table shape, both uniqueness
--     constraints (global unique(phone_number_id), unique(id, hotel_id)),
--     the partial unique index hotel_whatsapp_connections_primary_active_key
--     (at most one active+primary row per hotel — the final safety net this
--     function's own is_primary logic is designed to never need, but never
--     bypasses).
--   - supabase/tests/hotel_whatsapp_connections_check.sql: confirms the
--     table currently has zero write grants for any role.
--   - 0020_partner_requests.sql / 0023_partner_request_deliveries.sql: the
--     established SECURITY DEFINER pattern in this repo — row lock via
--     `for update` before any status-dependent decision, closed-vocabulary
--     outcomes never chosen by the caller, deterministic raised exceptions
--     with a stable errcode.
--
-- WHY THIS FUNCTION DELIBERATELY DOES **NOT** FOLLOW 0020/0023's OWN
-- `(auth.jwt() ->> 'role') = 'service_role' OR is_superadmin() OR
-- is_hotel_admin_for(...)` IN-BODY CHECK, AND DOES NOT CHECK
-- `current_user`/`session_user` EITHER:
--   1. current_user/session_user is UNRELIABLE here on its own terms: a
--      SECURITY DEFINER function executes as its OWNER for the ENTIRE
--      duration of the call — current_user inside this body is always the
--      role that ran this migration, never the original caller's role,
--      regardless of who invoked the function. Checking
--      `current_user = 'service_role'` would either always be false (if the
--      owner isn't literally named service_role) or, worse, always be true
--      for EVERY caller if it coincidentally matched — neither answers "who
--      actually called this". This is exactly the trap this task's own
--      instructions warned against.
--   2. auth.jwt() is ALSO not the right tool here, unlike in 0020/0023: those
--      functions are reachable by `authenticated` (many different end-user
--      sessions, each needing per-hotel authorization resolved from their
--      OWN JWT claims) as well as service_role, so an in-body identity
--      branch is essential there. This function is reachable by exactly ONE
--      Postgres role, full stop (see the REVOKE/GRANT block below) — and a
--      service_role-authenticated PostgREST/Supabase client call does not
--      reliably populate `request.jwt.claims` the same way an end-user
--      session's JWT does, making `auth.jwt() ->> 'role'` an unreliable
--      signal specifically for a service-role-only caller.
--   3. The ACTUAL, reliable enforcement mechanism for a single-role-only
--      RPC is PostgreSQL's own GRANT/REVOKE EXECUTE system: a role with no
--      EXECUTE privilege on this function is rejected by Postgres with
--      `insufficient_privilege` BEFORE the function body ever starts
--      running — this happens independently of SECURITY DEFINER, independently
--      of current_user's identity-switch, and independently of any JWT
--      claim. See the REVOKE ... / GRANT ... TO service_role block at the
--      end of this file, and hotel_whatsapp_connection_finalization_check.sql's
--      own tests 1-3, which prove this by actually attempting the call as
--      each role.
--
-- This "single-role, no in-body identity check, SECURITY DEFINER with
-- SET search_path = public" shape is not a new pattern in this repo: it
-- already matches 0009_widget_service_role_permissions.sql's own
-- widget_rate_limit_try_consume() exactly, for the identical reason (a
-- function reachable by exactly one Postgres role, where the GRANT itself
-- is the enforcement). Every reference inside this function is fully
-- schema-qualified regardless (public.hotels, public.hotel_whatsapp_connections),
-- so the search_path value has no bearing on identifier resolution safety
-- either way.
--
-- Never accepts, from any caller: access_token, authorization_code,
-- app_secret, system_user_token, a human WhatsApp phone number, or a
-- hotel_id read directly from the browser. p_hotel_id here is expected to
-- be supplied ONLY by trusted server code, itself resolved via
-- requireClientAccess() (not yet wired — see header above).
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
  -- Two concurrent finalize calls for the SAME hotel now serialize here:
  -- the second waits for the first transaction to commit (or roll back)
  -- before proceeding, so the "does an active+primary row already exist
  -- for this hotel" read below can never observe a stale/racing answer.
  -- =======================================================================
  perform 1 from public.hotels where id = p_hotel_id for update;
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
  -- layer this task's own instructions required).
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
  -- The `where hotel_whatsapp_connections.hotel_id = excluded.hotel_id`
  -- clause below is a SECOND, independent layer of cross-tenant protection,
  -- never the ONLY one (task section 6's own explicit warning: a false
  -- WHERE here could otherwise silently produce a zero-row update instead
  -- of a clear error) — the explicit lock-and-check above is what actually
  -- guarantees a cross-tenant attempt is rejected LOUDLY; this WHERE only
  -- guards the narrow window where two brand-new inserts for the SAME
  -- not-yet-existing phone_number_id race each other (neither sees a row to
  -- lock above, since neither has been committed yet) — in that case
  -- Postgres serializes the two INSERTs, the loser's ON CONFLICT branch
  -- evaluates against the winner's now-committed row, this WHERE clause
  -- correctly refuses to touch it, and the `if v_result_id is null`
  -- guard immediately below turns that silent zero-row outcome into the
  -- same explicit phone_number_cross_tenant exception — the other hotel's
  -- row is never modified in either path.
  -- =======================================================================
  insert into public.hotel_whatsapp_connections (
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
  where public.hotel_whatsapp_connections.hotel_id = excluded.hotel_id
  returning public.hotel_whatsapp_connections.id into v_result_id;

  if v_result_id is null then
    raise exception 'phone_number_cross_tenant' using errcode = 'P0001';
  end if;

  return query
  select c.id, c.hotel_id, c.waba_id, c.phone_number_id, c.business_id, c.connection_type, c.status, c.is_primary, c.connected_at
  from public.hotel_whatsapp_connections c
  where c.id = v_result_id;
end;
$$;

comment on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) is
  'The ONLY write path onto hotel_whatsapp_connections (0024). Represents a connection ALREADY validated server-side against Meta by the caller — always writes status = ''active'', never accepts a caller-supplied status. SECURITY DEFINER; authorization is enforced ENTIRELY by the EXECUTE grant below (service_role only), never by an in-body current_user/auth.jwt() check — see this migration''s own header comment for why both would be unreliable here. Never receives a token/code/secret/human phone number; never persists one.';

-- =========================================================================
-- Authorization (task section 3): EXECUTE restricted to service_role ONLY.
-- No policy is created on hotel_whatsapp_connections itself — direct
-- INSERT/UPDATE/DELETE remain revoked from every role exactly as
-- 0024 left them; this function is the sole exception, and only for the
-- role that owns it operationally (the Next.js server, via the Supabase
-- service-role client — see this file's own header comment on why this
-- grant, not an in-body check, is the real security boundary here).
-- =========================================================================
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from public;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from anon;
revoke execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) from authenticated;
grant execute on function public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text) to service_role;
