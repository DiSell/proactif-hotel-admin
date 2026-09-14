-- Proactif System — hotel customer follow-up / loyalty V1.
-- Additive only. No existing table, policy, function or workflow is changed.

create table public.hotel_customers (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  first_name text,
  last_name text,
  email text,
  phone text,
  source text not null default 'manual' check (source in ('manual', 'csv', 'pms')),
  external_reference text,
  marketing_allowed boolean not null default false,
  hotel_excluded boolean not null default false,
  customer_unsubscribed boolean not null default false,
  exclusion_reason text,
  marketing_status_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_customers_contact_present check (
    nullif(btrim(coalesce(email, '')), '') is not null
    or nullif(btrim(coalesce(phone, '')), '') is not null
  ),
  constraint hotel_customers_id_hotel_key unique (id, hotel_id)
);

create index hotel_customers_hotel_name_idx on public.hotel_customers (hotel_id, last_name, first_name);
create index hotel_customers_hotel_email_idx on public.hotel_customers (hotel_id, lower(email)) where email is not null;
create index hotel_customers_hotel_external_idx on public.hotel_customers (hotel_id, source, external_reference) where external_reference is not null;

create trigger set_updated_at before update on public.hotel_customers
  for each row execute function public.set_updated_at();

create or replace function public.set_customer_marketing_status_updated_at()
returns trigger language plpgsql as $$
begin
  if row(new.marketing_allowed, new.hotel_excluded, new.customer_unsubscribed, new.exclusion_reason)
     is distinct from
     row(old.marketing_allowed, old.hotel_excluded, old.customer_unsubscribed, old.exclusion_reason) then
    new.marketing_status_updated_at = now();
  end if;
  return new;
end;
$$;

create trigger set_customer_marketing_status_updated_at
  before update on public.hotel_customers
  for each row execute function public.set_customer_marketing_status_updated_at();

create table public.customer_stays (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  customer_id uuid not null,
  check_in date,
  check_out date not null,
  status text not null default 'completed' check (status in ('planned', 'checked_in', 'completed', 'cancelled')),
  source text not null default 'manual' check (source in ('manual', 'csv', 'pms')),
  external_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_stays_dates_order check (check_in is null or check_out >= check_in),
  constraint customer_stays_customer_hotel_fkey foreign key (customer_id, hotel_id)
    references public.hotel_customers (id, hotel_id) on delete cascade,
  constraint customer_stays_id_hotel_key unique (id, hotel_id)
);

create index customer_stays_hotel_customer_idx on public.customer_stays (hotel_id, customer_id, check_out desc);
create index customer_stays_due_idx on public.customer_stays (hotel_id, status, check_out);
create unique index customer_stays_external_key on public.customer_stays (hotel_id, source, external_reference)
  where external_reference is not null;
create trigger set_updated_at before update on public.customer_stays
  for each row execute function public.set_updated_at();

create table public.loyalty_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,
  enabled boolean not null default false,
  delay_days integer not null default 3 check (delay_days between 0 and 365),
  subject text not null default 'Merci pour votre séjour',
  content text not null default 'Merci d''avoir séjourné dans notre établissement. Nous espérons que votre séjour vous a plu.',
  channel text not null default 'email' check (channel = 'email'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()) ;
create trigger set_updated_at before update on public.loyalty_settings
  for each row execute function public.set_updated_at();

create table public.loyalty_campaigns (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  internal_name text not null,
  subject text not null,
  content text not null,
  offer_text text,
  audience_type text not null check (audience_type in ('general', 'targeted')),
  channel text not null default 'email' check (channel = 'email'),
  scheduled_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loyalty_campaigns_schedule_required check (status not in ('scheduled', 'sending', 'sent') or scheduled_at is not null),
  constraint loyalty_campaigns_id_hotel_key unique (id, hotel_id)
);
create index loyalty_campaigns_due_idx on public.loyalty_campaigns (status, scheduled_at);
create index loyalty_campaigns_hotel_created_idx on public.loyalty_campaigns (hotel_id, created_at desc);
create trigger set_updated_at before update on public.loyalty_campaigns
  for each row execute function public.set_updated_at();

create table public.loyalty_campaign_customers (
  campaign_id uuid not null,
  customer_id uuid not null,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, customer_id),
  foreign key (campaign_id, hotel_id) references public.loyalty_campaigns (id, hotel_id) on delete cascade,
  foreign key (customer_id, hotel_id) references public.hotel_customers (id, hotel_id) on delete cascade
);
create index loyalty_campaign_customers_hotel_idx on public.loyalty_campaign_customers (hotel_id);

create table public.loyalty_deliveries (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete restrict,
  customer_id uuid not null,
  campaign_id uuid,
  stay_id uuid,
  delivery_type text not null check (delivery_type in ('post_stay', 'marketing')),
  channel text not null check (channel = 'email'),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempted_at timestamptz,
  sent_at timestamptz,
  safe_error text,
  provider_reference text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, hotel_id) references public.hotel_customers (id, hotel_id) on delete restrict,
  foreign key (campaign_id, hotel_id) references public.loyalty_campaigns (id, hotel_id) on delete restrict,
  foreign key (stay_id, hotel_id) references public.customer_stays (id, hotel_id) on delete restrict,
  unique (hotel_id, idempotency_key),
  constraint loyalty_deliveries_origin check (
    (delivery_type = 'marketing' and campaign_id is not null and stay_id is null)
    or (delivery_type = 'post_stay' and stay_id is not null and campaign_id is null)
  )
);
create index loyalty_deliveries_customer_idx on public.loyalty_deliveries (hotel_id, customer_id, created_at desc);
create index loyalty_deliveries_campaign_idx on public.loyalty_deliveries (hotel_id, campaign_id) where campaign_id is not null;
create trigger set_updated_at before update on public.loyalty_deliveries
  for each row execute function public.set_updated_at();

alter table public.hotel_customers enable row level security;
alter table public.customer_stays enable row level security;
alter table public.loyalty_settings enable row level security;
alter table public.loyalty_campaigns enable row level security;
alter table public.loyalty_campaign_customers enable row level security;
alter table public.loyalty_deliveries enable row level security;

create policy "superadmin full access to hotel_customers" on public.hotel_customers for all using (public.is_superadmin()) with check (public.is_superadmin());
create policy "hotel_admin full access to own hotel_customers" on public.hotel_customers for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));
create policy "superadmin full access to customer_stays" on public.customer_stays for all using (public.is_superadmin()) with check (public.is_superadmin());
create policy "hotel_admin full access to own customer_stays" on public.customer_stays for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));
create policy "superadmin full access to loyalty_settings" on public.loyalty_settings for all using (public.is_superadmin()) with check (public.is_superadmin());
create policy "hotel_admin full access to own loyalty_settings" on public.loyalty_settings for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));
create policy "superadmin full access to loyalty_campaigns" on public.loyalty_campaigns for all using (public.is_superadmin()) with check (public.is_superadmin());
create policy "hotel_admin full access to own loyalty_campaigns" on public.loyalty_campaigns for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));
create policy "superadmin full access to loyalty_campaign_customers" on public.loyalty_campaign_customers for all using (public.is_superadmin()) with check (public.is_superadmin());
create policy "hotel_admin full access to own loyalty_campaign_customers" on public.loyalty_campaign_customers for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));
create policy "superadmin read loyalty_deliveries" on public.loyalty_deliveries for select using (public.is_superadmin());
create policy "hotel_admin read own loyalty_deliveries" on public.loyalty_deliveries for select using (public.is_hotel_admin_for(hotel_id));

grant select, insert, update, delete on public.hotel_customers, public.customer_stays, public.loyalty_settings, public.loyalty_campaigns, public.loyalty_campaign_customers to authenticated;
grant select on public.loyalty_deliveries to authenticated;
grant select, insert, update on public.hotel_customers, public.customer_stays, public.loyalty_settings, public.loyalty_campaigns, public.loyalty_campaign_customers, public.loyalty_deliveries to service_role;
revoke all on public.hotel_customers, public.customer_stays, public.loyalty_settings, public.loyalty_campaigns, public.loyalty_campaign_customers, public.loyalty_deliveries from anon;

