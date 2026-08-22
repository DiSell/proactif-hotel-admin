-- Proactif System — Jalon 1 schema
-- Multi-tenant hotel assistant platform. Every business table carries
-- hotel_id; isolation is enforced by RLS below, not by application discipline.

create extension if not exists pgcrypto;
create extension if not exists vector; -- prepared for future embeddings, unused this milestone

-- =========================================================================
-- profiles
-- =========================================================================
-- One row per Supabase Auth user. This milestone only ever creates
-- 'superadmin' rows (via the Supabase dashboard); 'hotel_admin' is reserved
-- for when hotels get their own accounts.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'superadmin' check (role in ('superadmin', 'hotel_admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================================================================
-- hotels
-- =========================================================================
create table public.hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  widget_key text not null unique, -- public identifier, format ps_live_xxxxxxxxxxxxxxxxxxxxxxxx — not a secret
  website text,
  logo_url text,
  address text,
  postal_code text,
  city text,
  country text,
  phone text,
  email text,
  primary_color text,
  secondary_color text,
  languages text[] not null default '{}',
  default_language text,
  booking_url text,
  spa_booking_url text,
  assistant_name text,
  assistant_enabled boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hotels_status_idx on public.hotels (status);

-- =========================================================================
-- chatbot_settings — guided behavior settings, one row per hotel.
-- The future AI engine builds its system prompt server-side from these
-- structured fields; nobody types a prompt by hand.
-- =========================================================================
create table public.chatbot_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,
  welcome_message text,
  fallback_message text,
  handoff_email text,
  handoff_phone text,
  tone text not null default 'warm' check (tone in ('professional', 'warm', 'elegant', 'direct')),
  formality text not null default 'vous' check (formality in ('vous', 'tu')),
  response_length text not null default 'normal' check (response_length in ('short', 'normal', 'detailed')),
  commercial_proactivity text not null default 'discreet' check (commercial_proactivity in ('disabled', 'discreet', 'proactive')),
  custom_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- no separate index needed: the `unique` constraint on hotel_id above
-- already creates one.

-- =========================================================================
-- widget_settings — display config for the embeddable widget, separate
-- from chatbot_settings (behavior) and from hotels.primary_color/
-- secondary_color (hotel identity, used beyond just the widget).
-- =========================================================================
create table public.widget_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,
  position text not null default 'bottom-right' check (position in ('bottom-right', 'bottom-left', 'top-right', 'top-left')),
  icon text not null default 'chat' check (icon in ('chat', 'help', 'message')),
  welcome_message text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- no separate index needed: the `unique` constraint on hotel_id above
-- already creates one.

-- =========================================================================
-- knowledge_sources — no RAG/embeddings yet, just structured source rows.
-- =========================================================================
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  type text not null check (type in ('url', 'text', 'document', 'faq', 'internal_note')),
  title text not null,
  content text,
  source_url text,
  storage_path text, -- Supabase Storage path, for type = 'document'
  file_size_bytes bigint,
  mime_type text,
  status text not null default 'pending' check (status in ('pending', 'indexed', 'error', 'disabled')),
  is_active boolean not null default true,
  last_synced_at timestamptz, -- distinct from updated_at: set when (re)indexed, null until then
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_sources_hotel_id_idx on public.knowledge_sources (hotel_id);

-- =========================================================================
-- conversations / messages — prepared for the future chat engine.
-- =========================================================================
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  session_id text not null,
  language text,
  status text not null default 'open' check (status in ('open', 'resolved', 'escalated')),
  visitor_name text,
  visitor_email text,
  visitor_phone text,
  gdpr_consent boolean not null default false,
  gdpr_consent_at timestamptz,
  started_at timestamptz not null default now(),
  last_message_at timestamptz
);

create index conversations_hotel_id_idx on public.conversations (hotel_id);
create index conversations_hotel_started_idx on public.conversations (hotel_id, started_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_hotel_id_idx on public.messages (hotel_id);
create index messages_conversation_id_idx on public.messages (conversation_id);

-- =========================================================================
-- updated_at maintenance
-- =========================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.hotels
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.chatbot_settings
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.widget_settings
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.knowledge_sources
  for each row execute function public.set_updated_at();

-- =========================================================================
-- Row Level Security
-- =========================================================================
-- security definer so the check itself isn't blocked by the RLS it enforces
-- (a plain `stable` function evaluated under the caller's row-security would
-- recurse into the profiles policy below).
create or replace function public.is_superadmin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'superadmin'
  );
$$;

revoke all on function public.is_superadmin() from public;
grant execute on function public.is_superadmin() to authenticated;

alter table public.profiles enable row level security;
alter table public.hotels enable row level security;
alter table public.chatbot_settings enable row level security;
alter table public.widget_settings enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

-- profiles: a user always sees their own row (needed for basic auth/profile
-- reads); superadmin sees/manages everyone's.
create policy "read own profile" on public.profiles
  for select
  using (id = auth.uid());

create policy "superadmin full access to profiles" on public.profiles
  for all
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- Every other business table: superadmin only, for now. Adding hotel_admin
-- scoping later is one more policy per table (e.g. checking a future
-- hotel_users mapping), not a rewrite of these.
create policy "superadmin full access" on public.hotels
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.chatbot_settings
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.widget_settings
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.knowledge_sources
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.conversations
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.messages
  for all using (public.is_superadmin()) with check (public.is_superadmin());

-- =========================================================================
-- Storage buckets
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('hotel-logos', 'hotel-logos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('hotel-knowledge', 'hotel-knowledge', false)
on conflict (id) do nothing;

create policy "public read hotel-logos" on storage.objects
  for select
  using (bucket_id = 'hotel-logos');

create policy "superadmin manage hotel-logos" on storage.objects
  for all
  using (bucket_id = 'hotel-logos' and public.is_superadmin())
  with check (bucket_id = 'hotel-logos' and public.is_superadmin());

create policy "superadmin manage hotel-knowledge" on storage.objects
  for all
  using (bucket_id = 'hotel-knowledge' and public.is_superadmin())
  with check (bucket_id = 'hotel-knowledge' and public.is_superadmin());
