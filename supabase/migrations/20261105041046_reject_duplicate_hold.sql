-- すでに保留中の明細への2回目の保留を拒否する（別タブ・別端末・再送による保留ログと確認時間の二重計上を防ぐ）。
-- 20261020000700_record_human_review.sql の record_human_review を再作成し、変更は「保留済みへの保留を拒否する」1か所だけ。
-- 判定は明細を for update でロックしたあとに行うので、並行する2つ目の保留は先の確定を待ったあと、ここで拒否される。
-- 拒否は例外（ロールバック）なので、human_reviews への追記も bank_transactions の更新も起きない。
-- 保留 → 承認・修正・却下は従来どおり通す。権限・閲覧範囲の判定は新しい判定より前にあり、状態は漏らさない。
-- 既に重複した履歴の修復はこのマイグレーションの範囲外（追記専用の履歴は変更しない）。

create or replace function public.record_human_review(
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
  -- 前後の空白（全角空白・改行を含む）を除いた理由
  v_reason text := nullif(regexp_replace(coalesce(p_reason, ''), '^[[:space:]　]+|[[:space:]　]+$', '', 'g'), '');
begin
  if v_user is null or not exists (select 1 from public.staff_members where user_id = v_user) then
    raise exception 'ログインした担当者だけが確認を記録できます' using errcode = 'insufficient_privilege';
  end if;

  select * into d from public.ai_decisions where id = p_ai_decision_id;
  if not found or not public.can_access_customer(d.customer_id) then
    raise exception '仕訳候補が見つかりません' using errcode = 'no_data_found';
  end if;

  if p_action = 'hold' and v_reason is null then
    raise exception '保留の理由を入力してください';
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

  -- ロック後の状態で判定する。保留中の明細への保留は記録しない（確認ログ・確認時間の二重計上を防ぐ）
  if p_action = 'hold' and t.status = 'on_hold' then
    raise exception 'この明細はすでに保留中です。管理者の確認を待ってください';
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
    (d.customer_id, d.id, p_action, v_final, v_diff, v_reason, v_user, p_review_seconds, p_bulk)
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

-- create or replace は既存の権限を保つが、意図を明示するため同じ権限を再指定する
revoke all on function public.record_human_review(uuid, text, jsonb, text, integer, boolean) from public, anon;
grant execute on function public.record_human_review(uuid, text, jsonb, text, integer, boolean) to authenticated;
