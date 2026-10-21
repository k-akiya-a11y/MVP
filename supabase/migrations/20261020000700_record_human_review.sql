-- 人の確認（承認・修正・保留・却下）を記録する唯一の入口。
-- 1トランザクションで、確認ログの追記・明細の状態更新・承認内容の過去仕訳への追加（設計書6章「学習」）を行う。
-- security definer なので、閲覧範囲（can_access_customer）と確認者（auth.uid()）はこの関数の中で確かめる。
--
-- 承認者（設計書10章 決めること3）: 確定につながる操作（承認・修正・却下）は管理者だけが行える。
-- 担当者ができるのは保留（理由を添えて管理者に回す）だけ。

-- 担当者が human_reviews に直接書くことは止め、この関数だけを通す
revoke insert on public.human_reviews from authenticated;
drop policy human_reviews_insert on public.human_reviews;

-- 確定内容の正規化と、マスタにある値かの検査
create function public.normalize_final_entry(p_customer_id uuid, p_entry jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_tag jsonb;
begin
  if jsonb_typeof(p_entry) is distinct from 'object' then
    raise exception 'final entry must be an object';
  end if;
  v := jsonb_build_object(
    'account_item_id', (p_entry ->> 'account_item_id')::bigint,
    'tax_code', (p_entry ->> 'tax_code')::integer,
    'partner_id', (p_entry ->> 'partner_id')::bigint,
    'item_id', (p_entry ->> 'item_id')::bigint,
    'section_id', (p_entry ->> 'section_id')::bigint,
    'tag_ids', coalesce(
      (select jsonb_agg(distinct (t)::bigint order by (t)::bigint)
       from jsonb_array_elements_text(coalesce(p_entry -> 'tag_ids', '[]'::jsonb)) as t),
      '[]'::jsonb),
    'description', coalesce(p_entry ->> 'description', '')
  );
  if v ->> 'account_item_id' is null or v ->> 'tax_code' is null then
    raise exception '勘定科目と税区分は必須です';
  end if;
  if not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id and m.kind = 'account_item'
                 and m.freee_id = (v ->> 'account_item_id')::bigint and m.available) then
    raise exception '勘定科目 % はマスタにありません', v ->> 'account_item_id';
  end if;
  if not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id and m.kind = 'tax'
                 and m.freee_id = (v ->> 'tax_code')::bigint and m.available) then
    raise exception '税区分 % はマスタにありません', v ->> 'tax_code';
  end if;
  if v ->> 'partner_id' is not null and not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id
      and m.kind = 'partner' and m.freee_id = (v ->> 'partner_id')::bigint and m.available) then
    raise exception '取引先 % はマスタにありません', v ->> 'partner_id';
  end if;
  if v ->> 'item_id' is not null and not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id
      and m.kind = 'item' and m.freee_id = (v ->> 'item_id')::bigint and m.available) then
    raise exception '品目 % はマスタにありません', v ->> 'item_id';
  end if;
  if v ->> 'section_id' is not null and not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id
      and m.kind = 'section' and m.freee_id = (v ->> 'section_id')::bigint and m.available) then
    raise exception '部門 % はマスタにありません', v ->> 'section_id';
  end if;
  for v_tag in select * from jsonb_array_elements(v -> 'tag_ids') loop
    if not exists (select 1 from public.freee_masters m where m.customer_id = p_customer_id
                   and m.kind = 'tag' and m.freee_id = (v_tag #>> '{}')::bigint and m.available) then
      raise exception 'メモタグ % はマスタにありません', v_tag;
    end if;
  end loop;
  return v;
end;
$$;

create function public.record_human_review(
  p_ai_decision_id uuid,
  p_action text,
  p_final_entry jsonb,
  p_reason text,
  p_review_seconds integer,
  p_bulk boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.ai_decisions%rowtype;
  t public.bank_transactions%rowtype;
  v_final jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_key text;
  v_review_id uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null or not exists (select 1 from public.staff_members where user_id = v_user) then
    raise exception 'ログインした担当者だけが確認を記録できます' using errcode = 'insufficient_privilege';
  end if;

  select * into d from public.ai_decisions where id = p_ai_decision_id;
  if not found or not public.can_access_customer(d.customer_id) then
    raise exception '仕訳候補が見つかりません' using errcode = 'no_data_found';
  end if;

  if p_action in ('approve', 'correct', 'reject') and not public.is_admin() then
    raise exception '承認・修正・却下は承認者（管理者）だけが行えます。保留にして理由を残してください'
      using errcode = 'insufficient_privilege';
  end if;

  select * into t from public.bank_transactions where id = d.bank_transaction_id for update;
  if t.status not in ('proposed', 'on_hold') then
    raise exception 'この明細はすでに確認済みです（%）', t.status;
  end if;
  if exists (
    select 1 from public.ai_decisions newer
    where newer.bank_transaction_id = d.bank_transaction_id
      and (newer.created_at, newer.id) > (d.created_at, d.id)
  ) then
    raise exception 'より新しい仕訳候補があります。画面を更新してください';
  end if;

  if p_bulk and (p_action <> 'approve' or d.confidence <> 'high') then
    raise exception 'まとめて承認できるのは確信度「高」だけです';
  end if;
  -- 保留した明細は、保留の理由を見たうえで1件ずつ確認する
  if p_bulk and t.status <> 'proposed' then
    raise exception '保留中の明細はまとめて承認できません。1件ずつ確認してください';
  end if;

  if p_action = 'approve' then
    if d.proposal is null then
      raise exception '提案がないので承認できません。修正として入力してください';
    end if;
    v_final := public.normalize_final_entry(d.customer_id, d.proposal);
  elsif p_action = 'correct' then
    v_final := public.normalize_final_entry(d.customer_id, p_final_entry);
    for v_key in select jsonb_object_keys(v_final) loop
      if d.proposal is null or (d.proposal -> v_key) is distinct from (v_final -> v_key) then
        v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('before', d.proposal -> v_key, 'after', v_final -> v_key));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      raise exception '提案から変更がありません。承認してください';
    end if;
  elsif p_action in ('hold', 'reject') then
    v_final := null;
  else
    raise exception 'unknown action %', p_action;
  end if;

  insert into public.human_reviews
    (customer_id, ai_decision_id, action, final_entry, diff, reason, reviewer_id, review_seconds, bulk)
  values
    (d.customer_id, d.id, p_action, v_final, v_diff, nullif(p_reason, ''), v_user, p_review_seconds, p_bulk)
  returning id into v_review_id;

  update public.bank_transactions
  set status = case p_action when 'hold' then 'on_hold' when 'reject' then 'rejected' else 'approved' end
  where id = t.id;

  -- 承認・修正した結果は、次の判定から過去仕訳として使う
  if v_final is not null then
    insert into public.past_journal_entries (
      customer_id, source, ai_decision_id, entry_date, amount, direction, bank_description, partner_key,
      partner_id, account_item_id, tax_code, item_id, section_id, tag_ids, description
    ) values (
      d.customer_id, 'approved_proposal', d.id, t.txn_date, t.amount, t.direction, t.description,
      d.transaction_snapshot ->> 'partnerKey',
      (v_final ->> 'partner_id')::bigint, (v_final ->> 'account_item_id')::bigint, (v_final ->> 'tax_code')::integer,
      (v_final ->> 'item_id')::bigint, (v_final ->> 'section_id')::bigint,
      array(select jsonb_array_elements_text(v_final -> 'tag_ids')::bigint),
      v_final ->> 'description'
    );
  end if;

  return v_review_id;
end;
$$;

revoke all on function public.normalize_final_entry(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_human_review(uuid, text, jsonb, text, integer, boolean) from public, anon;
grant execute on function public.record_human_review(uuid, text, jsonb, text, integer, boolean) to authenticated;
