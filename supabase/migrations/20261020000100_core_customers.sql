-- 顧客・担当者・閲覧範囲（設計書5章「顧客基本情報」、9章「閲覧範囲」）
--
-- 役割は管理者（admin）と担当者（staff）の2つ。担当者は customer_assignments に
-- 登録された顧客だけを閲覧・操作できる。管理者は全顧客を閲覧できる。

create extension if not exists pgcrypto;

-- 結乃社のスタッフ。auth.users（Supabase Auth、Google ログイン）と1対1。
create table public.staff_members (
  user_id uuid primary key references auth.users (id) on delete restrict,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

-- 顧客基本情報。freee の事業所ID（company_id）で顧客を切り替える。
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  freee_company_id bigint unique,
  fiscal_year_end_month smallint not null check (fiscal_year_end_month between 1 and 12),
  -- 課税方式: 原則課税・簡易課税・免税
  tax_method text not null check (tax_method in ('general', 'simplified', 'exempt')),
  invoice_registered boolean not null default false,
  -- この金額（円）以上の取引は常に確信度「低」（設計書7章、初期値30万円）
  low_confidence_amount_threshold bigint not null default 300000
    check (low_confidence_amount_threshold > 0),
  created_at timestamptz not null default now()
);

-- 担当者と顧客の割当。RLS の閲覧範囲はこの表で決まる。
create table public.customer_assignments (
  customer_id uuid not null references public.customers (id) on delete cascade,
  user_id uuid not null references public.staff_members (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (customer_id, user_id)
);

create index customer_assignments_user_idx on public.customer_assignments (user_id);

-- 現在のユーザーが管理者か
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_members
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- 現在のユーザーがその顧客を閲覧・操作できるか（管理者、または割当済みの担当者）
create function public.can_access_customer(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1 from public.customer_assignments
    where customer_id = target_customer_id and user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.can_access_customer(uuid) from public;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.can_access_customer(uuid) to authenticated, service_role;

-- 追記専用テーブル用: UPDATE・DELETE を拒否するトリガー関数。
-- 権限（REVOKE）に加えて、テーブル所有者やサービスロールからの変更も止める。
create function public.reject_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only (% is not allowed)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

alter table public.staff_members enable row level security;
alter table public.customers enable row level security;
alter table public.customer_assignments enable row level security;

-- Supabase は public スキーマの新規テーブルに anon/authenticated へ全権限を付けるため、
-- 必要な権限だけを明示的に付け直す。anon（未ログイン）には何も許可しない。
revoke all on public.staff_members, public.customers, public.customer_assignments from anon, authenticated;
grant select on public.staff_members, public.customers, public.customer_assignments to authenticated;
grant insert, update on public.customers, public.customer_assignments to authenticated;
grant delete on public.customer_assignments to authenticated;

create policy staff_members_select on public.staff_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy customers_select on public.customers
  for select to authenticated
  using (public.can_access_customer(id));

create policy customers_admin_insert on public.customers
  for insert to authenticated
  with check (public.is_admin());

create policy customers_admin_update on public.customers
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy customer_assignments_select on public.customer_assignments
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy customer_assignments_admin_write on public.customer_assignments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
