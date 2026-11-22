-- 新しい文章メモ（親 customer_notes と版1 customer_note_versions）を「無効」で1回だけ作る。
--
-- 既存の権限（担当者の INSERT と RLS）で許されている操作を、1つのトランザクションにまとめるだけの関数。
-- 権限・ポリシー・テーブルは変えない（SECURITY INVOKER。呼び出した担当者の権限で動き、RLS がそのまま効く）。
--   - 作成者は auth.uid()。状態は常に 'inactive'、版は 1。引数では受け取らない
--     （直接この関数を呼んでも、有効な状態・別の作成者・別の版は指定できない）
--   - タイトルと本文は空白だけを拒否する。それ以外は前後の空白・改行も含めて入力のまま保存する（長さの上限は設けない）。
--     NUL 文字は PostgreSQL の text に入らないため、ここでは別に判定しない
--   - p_note_id は呼出側が決める依頼ID。同じIDで2回目に呼ぶと主キー重複（23505）で失敗し、何も上書きしない
--   - 親と版1は同じ関数（同じトランザクション）で入るので、版1の INSERT が失敗すれば親も残らない
--   - UPDATE / DELETE はしない。既存のメモ・版は変えない

create function public.create_customer_note(
  p_customer_id uuid,
  p_note_id uuid,
  p_title text,
  p_body text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  -- 空白の集合は JS の String.prototype.trim と同じ（E'\v' は PostgreSQL では垂直タブにならないため chr() で明示する）:
  -- U+0009-000D, 0020, 00A0, 1680, 2000-200A, 2028, 2029, 202F, 205F, 3000, FEFF
  v_space constant text :=
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
    || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279);
begin
  if p_customer_id is null or p_note_id is null or p_title is null or p_body is null then
    raise exception 'all arguments are required' using errcode = '22004';
  end if;
  if btrim(p_title, v_space) = '' then
    raise exception 'title must not be blank' using errcode = '22023';
  end if;
  if btrim(p_body, v_space) = '' then
    raise exception 'body must not be blank' using errcode = '22023';
  end if;

  if v_user is null or not public.can_access_customer(p_customer_id) then
    raise exception 'not allowed to create notes for this customer' using errcode = '42501';
  end if;

  insert into public.customer_notes (id, customer_id, created_by)
  values (p_note_id, p_customer_id, v_user);

  insert into public.customer_note_versions (note_id, version, customer_id, status, title, body, created_by)
  values (p_note_id, 1, p_customer_id, 'inactive', p_title, p_body, v_user);

  return p_note_id;
end;
$$;

revoke all on function public.create_customer_note(uuid, uuid, text, text) from public, anon, service_role;
grant execute on function public.create_customer_note(uuid, uuid, text, text) to authenticated;
