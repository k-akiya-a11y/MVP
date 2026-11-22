-- 過去仕訳の候補から、新しい顧客ルール（親 journal_rules と版1 journal_rule_versions）を「提案中」で1回だけ作る。
--
-- 既存の権限（担当者の SELECT / INSERT と RLS）で許されている操作を、1つのトランザクションにまとめるだけの関数。
-- 権限・ポリシー・テーブルは変えない（SECURITY INVOKER。呼び出した担当者の権限で動き、RLS がそのまま効く）。
--   - 作成者は auth.uid()。状態は常に 'proposed'、作成元は常に 'past_entries'、版は 1。引数では受け取らない
--     （直接この関数を呼んでも、有効な状態・別の作成者・別の作成元は指定できない）
--   - 条件は取引先キー（完全一致）と入出金の向きだけ。金額・口座・摘要・有効期間・補助科目・メモタグ・摘要の雛形は入れない
--   - 担当者が見える過去仕訳で、同じ顧客・取引先キー（完全一致）・向きのものが1件以上あり、その「すべて」が
--     指定の勘定科目であることを確認する。件数の下限は設けない（1件だけの扱いは画面で人が判断する）
--   - 勘定科目と税区分は、同じ顧客の有効（available）なマスタにあることを確認する
--   - p_rule_id は呼出側が決める依頼ID。同じIDで2回目に呼ぶと主キー重複（23505）で失敗し、何も上書きしない
-- 検証は確認の時点のものであり、保存後も過去仕訳が変わらないことを保証するものではない。

create function public.create_rule_from_past_candidate(
  p_customer_id uuid,
  p_rule_id uuid,
  p_partner_key text,
  p_direction text,
  p_account_item_id bigint,
  p_tax_code integer,
  p_priority integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_total bigint;
  v_other bigint;
begin
  if p_customer_id is null or p_rule_id is null or p_partner_key is null or p_direction is null
     or p_account_item_id is null or p_tax_code is null or p_priority is null then
    raise exception 'all arguments are required' using errcode = '22004';
  end if;
  -- 取引先キーは完全一致で使う。空白だけのキーは候補にならない（前後の空白は削らない）。
  -- 空白の集合は JS の String.prototype.trim と同じ（E'\v' は PostgreSQL では垂直タブにならないため chr() で明示する）:
  -- U+0009-000D, 0020, 00A0, 1680, 2000-200A, 2028, 2029, 202F, 205F, 3000, FEFF
  if btrim(
       p_partner_key,
       chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
       || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
       || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
       || chr(8287) || chr(12288) || chr(65279)
     ) = '' then
    raise exception 'partner key must not be blank' using errcode = '22023';
  end if;
  if p_direction not in ('income', 'expense') then
    raise exception 'direction must be income or expense' using errcode = '22023';
  end if;
  if p_account_item_id < 1 then
    raise exception 'account item id must be positive' using errcode = '22023';
  end if;

  if v_user is null or not public.can_access_customer(p_customer_id) then
    raise exception 'not allowed to create rules for this customer' using errcode = '42501';
  end if;

  -- 担当者の権限（RLS）で見える過去仕訳だけを数える
  select count(*), count(*) filter (where account_item_id <> p_account_item_id)
    into v_total, v_other
  from public.past_journal_entries
  where customer_id = p_customer_id and partner_key = p_partner_key and direction = p_direction;
  if v_total = 0 then
    raise exception 'no past journal entries for this partner key and direction';
  end if;
  if v_other > 0 then
    raise exception 'past journal entries for this partner key and direction use other accounts';
  end if;

  if not exists (
    select 1 from public.freee_masters
    where customer_id = p_customer_id and kind = 'account_item' and freee_id = p_account_item_id and available
  ) then
    raise exception 'account item % is not an available master of this customer', p_account_item_id;
  end if;
  if not exists (
    select 1 from public.freee_masters
    where customer_id = p_customer_id and kind = 'tax' and freee_id = p_tax_code and available
  ) then
    raise exception 'tax code % is not an available master of this customer', p_tax_code;
  end if;

  insert into public.journal_rules (id, customer_id, created_by)
  values (p_rule_id, p_customer_id, v_user);

  insert into public.journal_rule_versions (
    rule_id, version, customer_id, priority, status, source,
    cond_partner_key, cond_description_keyword, cond_amount_min, cond_amount_max, cond_wallet_id, cond_direction,
    account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description_template,
    valid_from, valid_to, created_by
  ) values (
    p_rule_id, 1, p_customer_id, p_priority, 'proposed', 'past_entries',
    p_partner_key, null, null, null, null, p_direction,
    p_account_item_id, p_tax_code, null, null, null, '{}', null,
    null, null, v_user
  );

  return p_rule_id;
end;
$$;

revoke all on function public.create_rule_from_past_candidate(uuid, uuid, text, text, bigint, integer, integer)
  from public, anon, service_role;
grant execute on function public.create_rule_from_past_candidate(uuid, uuid, text, text, bigint, integer, integer)
  to authenticated;
