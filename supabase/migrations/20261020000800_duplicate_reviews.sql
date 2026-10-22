-- 重複の疑いがある明細の確認（取込済みの明細と区別できなかった行）。
-- 人が「別の取引」か「重複」かを決め、1操作1行で追記専用のログに残す。
--   - 別の取引: 未判定に戻し、通常どおり仕訳候補を作る（確定には承認者の承認が要る）
--   - 重複: 明細を除外する。取引を帳簿から外す判断なので承認者（管理者）だけが行える

create table public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  bank_transaction_id uuid not null,
  duplicate_of_id uuid not null,
  resolution text not null check (resolution in ('distinct', 'duplicate')),
  reason text,
  reviewer_id uuid not null references public.staff_members (user_id),
  created_at timestamptz not null default now(),
  foreign key (bank_transaction_id, customer_id) references public.bank_transactions (id, customer_id),
  foreign key (duplicate_of_id, customer_id) references public.bank_transactions (id, customer_id)
);

create index duplicate_reviews_txn_idx on public.duplicate_reviews (bank_transaction_id);

create trigger duplicate_reviews_append_only
  before update or delete on public.duplicate_reviews
  for each row execute function public.reject_update_delete();
create trigger duplicate_reviews_no_truncate
  before truncate on public.duplicate_reviews
  for each statement execute function public.reject_update_delete();

alter table public.duplicate_reviews enable row level security;
revoke all on public.duplicate_reviews from anon, authenticated, service_role;
grant select on public.duplicate_reviews to authenticated, service_role;
grant insert on public.duplicate_reviews to service_role;
create policy duplicate_reviews_select on public.duplicate_reviews
  for select to authenticated using (public.can_access_customer(customer_id));

create function public.resolve_suspected_duplicate(p_bank_transaction_id uuid, p_resolution text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.bank_transactions%rowtype;
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null or not exists (select 1 from public.staff_members where user_id = v_user) then
    raise exception 'ログインした担当者だけが確認を記録できます' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.bank_transactions where id = p_bank_transaction_id for update;
  if not found or not public.can_access_customer(t.customer_id) then
    raise exception '明細が見つかりません' using errcode = 'no_data_found';
  end if;
  if t.status <> 'duplicate_suspected' then
    raise exception 'この明細は重複の確認待ちではありません（%）', t.status;
  end if;
  if p_resolution not in ('distinct', 'duplicate') then
    raise exception 'unknown resolution %', p_resolution;
  end if;
  if p_resolution = 'duplicate' and not public.is_admin() then
    raise exception '重複として除外できるのは承認者（管理者）だけです' using errcode = 'insufficient_privilege';
  end if;

  insert into public.duplicate_reviews
    (customer_id, bank_transaction_id, duplicate_of_id, resolution, reason, reviewer_id)
  values
    (t.customer_id, t.id, t.duplicate_of_id, p_resolution, nullif(p_reason, ''), v_user)
  returning id into v_id;

  update public.bank_transactions
  set status = case p_resolution when 'distinct' then 'new' else 'duplicate' end
  where id = t.id;

  return v_id;
end;
$$;

revoke all on function public.resolve_suspected_duplicate(uuid, text, text) from public, anon;
grant execute on function public.resolve_suspected_duplicate(uuid, text, text) to authenticated;
