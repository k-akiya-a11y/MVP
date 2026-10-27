-- 別々の CSV にある別取引を、重複キーの衝突だけで読み飛ばさないようにする。
--
-- 問題: 重複キーの連番はファイルごとに 1 から数え直す。CSV A に「同日・出金1,000・同じ店・残高9,000」が1件、
-- CSV B に「入金1,000・残高10,000」と、別の取引である同じ「同日・出金1,000・同じ店・残高9,000」があると、
-- 後者は A の行と同じキーになる。従来は「残高があれば同じ取引」として読み飛ばしていたため、別取引が黙って消えた。
-- 残高が同じでも、別ファイルのキーの一致は同一取引の証明にならない。
--
-- 変更後の規則（キーが取込済みの明細と重なった行について）:
--   - 読み飛ばしてよいのは「取込全体の再実行」だけ。取り込む行の内容全体（口座・全行の日付・入出金・金額・摘要・残高・キー）の
--     ハッシュを DB が p_rows から計算し、同じ内容・同じ口座の完了済みの取込があり、かつ全行について
--     その取込が登録した明細（同じ内容）が実在するときだけ、残高のある行を読み飛ばす。
--     クライアントが渡す値（ハッシュなど）は信用せず、行の内容は DB 側で突き合わせる。
--   - それ以外（一部だけ重なる CSV、内容が変わった行、残高がない行、この変更より前の取込＝ハッシュなし）は
--     すべて捨てずに「重複の疑い」として登録し、人が「別の取引」か「重複」かを決める。
--     不確かなものを読み飛ばすより、人の確認に回すほうが安全なため。
--   - 同じ内容の取込が一致することは「同じファイルを再度取り込んだ」ことの証拠（再実行の識別）であって、
--     別々の実取引が偶然同じ内容になることがないことの証明ではない。
--   - 同じ顧客の取込は、顧客単位のロックで直列にする（同時に取り込んでも、後の取込は先の取込の結果を見て判定する）。
-- 取込記録の件数・金額の照合（読めた行 = 登録 + 読み飛ばし + 重複の疑い）、口座の種類の照合、RLS は変えない。
-- 既存のマイグレーションは書き換えず、関数を置き換える（create or replace は権限を引き継ぐ）。

-- 取込内容のハッシュ。null はこの変更より前の取込（内容を確かめられないので、再実行の証拠にしない）
alter table public.statement_imports add column batch_hash text;
create index statement_imports_batch_hash_idx
  on public.statement_imports (customer_id, wallet_id, batch_hash)
  where batch_hash is not null;

-- 取込内容（顧客・口座・全行）のハッシュ。行の並び順には依存しない
create function public.statement_batch_hash(p_customer_id uuid, p_wallet_id uuid, p_rows jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      p_customer_id::text || E'\x1d' || p_wallet_id::text || E'\x1d' || coalesce(
        string_agg(
          concat_ws(E'\x1f',
            coalesce(r.dedupe_key, ''), coalesce(to_char(r.txn_date, 'YYYY-MM-DD'), ''), coalesce(r.direction, ''),
            coalesce(r.amount::text, ''), coalesce(r.description, ''), coalesce(r.balance::text, '')),
          E'\x1e' order by r.dedupe_key collate "C", r.txn_date, r.direction, r.amount, r.description collate "C", r.balance),
        ''),
      'UTF8')),
    'hex')
  from jsonb_to_recordset(p_rows) as r(txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text);
$$;
revoke all on function public.statement_batch_hash(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.import_bank_statement(
  p_customer_id uuid,
  p_wallet_id uuid,
  p_source text,
  p_file_name text,
  p_csv_format text,
  -- [{ "txn_date": "2026-10-01", "amount": 1000, "direction": "expense",
  --    "description": "...", "balance": 12345 | null, "dedupe_key": "..." }]
  p_rows jsonb,
  p_source_row_count integer,
  -- [{ "line": 12, "reason": "金額が0" }]
  p_ignored_rows jsonb
)
returns table (
  import_id uuid,
  inserted_count integer,
  skipped_duplicate_count integer,
  suspected_duplicate_count integer,
  income_total bigint,
  expense_total bigint,
  inserted_amount_total bigint,
  skipped_amount_total bigint,
  suspected_amount_total bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import_id uuid;
  v_wallet_kind text;
  v_format_kind text;
  v_total integer;
  v_batch_hash text;
  v_replay boolean;
  v_classified jsonb;
  v_income bigint;
  v_expense bigint;
  v_skipped integer;
  v_skipped_amount bigint;
  v_suspected integer;
  v_suspected_amount bigint;
  v_inserted integer;
  v_inserted_amount bigint;
  v_registered integer;
begin
  perform public.assert_can_import(p_customer_id);

  -- 口座はその顧客のものであること、CSV の形式が口座の種類に合うこと（明細を1件も登録する前に確かめる）
  select w.kind into v_wallet_kind from public.wallets w where w.id = p_wallet_id and w.customer_id = p_customer_id;
  if v_wallet_kind is null then
    raise exception '口座が見つかりません' using errcode = 'no_data_found';
  end if;
  v_format_kind := public.statement_csv_format_wallet_kind(p_csv_format);
  if v_format_kind is null then
    raise exception '未対応の CSV 形式です: %', coalesce(p_csv_format, '(なし)');
  end if;
  if v_format_kind <> v_wallet_kind then
    raise exception '選んだ口座と CSV の形式が合っていません（% の形式は % の口座にだけ取り込めます）', p_csv_format, v_format_kind;
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_ignored_rows) is distinct from 'array' then
    raise exception 'p_rows and p_ignored_rows must be JSON arrays';
  end if;
  v_total := jsonb_array_length(p_rows);
  if (select count(distinct r ->> 'dedupe_key') from jsonb_array_elements(p_rows) as r) <> v_total then
    raise exception '同じファイルの中で重複キーが重なっています';
  end if;

  -- 同じ顧客の取込を直列にする（キーの重なりの判定が、同時に進む別の取込の結果を見落とさないように）。
  -- 顧客単位なのは、重複キーの一意性が顧客単位だから。トランザクションの終わりで自動的に解放される
  perform pg_advisory_xact_lock(hashtextextended('statement_import:' || p_customer_id::text, 0));

  select coalesce(sum(r.amount) filter (where r.direction = 'income'), 0),
         coalesce(sum(r.amount) filter (where r.direction = 'expense'), 0)
  into v_income, v_expense
  from jsonb_to_recordset(p_rows) as r(amount bigint, direction text);

  v_batch_hash := public.statement_batch_hash(p_customer_id, p_wallet_id, p_rows);

  -- 各行を判定する。
  --   existing_id  : 同じキーの取込済みの明細
  --   has_evidence : 同じ内容・同じ口座の完了済みの取込が、この行と同じ内容の明細を登録している
  --                  （キーそのもの、またはその取込で重複の疑いとして登録した控え）
  with incoming as (
    select r.*, existing.id as existing_id,
      exists (
        select 1
        from public.bank_transactions e
        join public.statement_imports si on si.id = e.import_id and si.customer_id = e.customer_id
        where e.customer_id = p_customer_id
          and si.wallet_id = p_wallet_id
          and si.status = 'completed'
          and si.batch_hash = v_batch_hash
          and e.wallet_id = p_wallet_id
          and e.dedupe_key in (r.dedupe_key, r.dedupe_key || ':suspected:' || e.import_id)
          and e.txn_date = r.txn_date
          and e.amount = r.amount
          and e.direction = r.direction
          and e.description = r.description
          and e.balance is not distinct from r.balance
      ) as has_evidence
    from jsonb_to_recordset(p_rows) as r(
      txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text
    )
    left join public.bank_transactions existing
      on existing.customer_id = p_customer_id and existing.dedupe_key = r.dedupe_key
  )
  select coalesce(bool_and(i.has_evidence), false) into v_replay from incoming i;

  -- 取込全体の再実行（全行に証拠がある）のときだけ、残高のある行を読み飛ばす。それ以外の重なりはすべて重複の疑い
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
  into v_classified
  from (
    select r.*, existing.id as existing_id,
      case
        when existing.id is null then 'new'
        when v_replay and r.balance is not null then 'skipped'
        else 'suspected'
      end as kind
    from jsonb_to_recordset(p_rows) as r(
      txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text
    )
    left join public.bank_transactions existing
      on existing.customer_id = p_customer_id and existing.dedupe_key = r.dedupe_key
  ) c;

  select count(*) filter (where c.kind = 'skipped'), coalesce(sum(c.amount) filter (where c.kind = 'skipped'), 0),
         count(*) filter (where c.kind = 'suspected'), coalesce(sum(c.amount) filter (where c.kind = 'suspected'), 0)
  into v_skipped, v_skipped_amount, v_suspected, v_suspected_amount
  from jsonb_to_recordset(v_classified) as c(amount bigint, kind text);

  v_inserted := v_total - v_skipped - v_suspected;
  v_inserted_amount := v_income + v_expense - v_skipped_amount - v_suspected_amount;

  -- 件数・金額を先に数えて取込記録に残す（取込記録は後から更新しない）
  insert into public.statement_imports
    (customer_id, wallet_id, source, file_name, csv_format, imported_by, status,
     source_row_count, row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count, ignored_rows,
     income_total, expense_total, inserted_amount_total, skipped_amount_total, suspected_amount_total, batch_hash)
  values
    (p_customer_id, p_wallet_id, p_source, p_file_name, p_csv_format, auth.uid(), 'completed',
     p_source_row_count, v_total, v_inserted, v_skipped, v_suspected, p_ignored_rows,
     v_income, v_expense, v_inserted_amount, v_skipped_amount, v_suspected_amount, v_batch_hash)
  returning id into v_import_id;

  with c as (
    select * from jsonb_to_recordset(v_classified) as c(
      txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text,
      existing_id uuid, kind text
    )
  ),
  new_rows as (
    insert into public.bank_transactions
      (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key)
    select p_customer_id, p_wallet_id, v_import_id, txn_date, amount, direction, description, balance, dedupe_key
    from c
    where kind = 'new'
    returning 1
  ),
  -- 重複の疑い: キーは取込ごとに変えて一意にし、元の明細を指しておく
  suspected_rows as (
    insert into public.bank_transactions
      (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key,
       status, duplicate_of_id)
    select p_customer_id, p_wallet_id, v_import_id, txn_date, amount, direction, description, balance,
           dedupe_key || ':suspected:' || v_import_id, 'duplicate_suspected', existing_id
    from c
    where kind = 'suspected'
    returning 1
  )
  select (select count(*) from new_rows) + (select count(*) from suspected_rows) into v_registered;

  -- 先に数えた件数と実際に登録した件数が違えば、全体を取り消す
  if v_registered <> v_inserted + v_suspected then
    raise exception '取込中に明細が変わりました。もう一度取り込んでください（想定 %、登録 %）', v_inserted + v_suspected, v_registered;
  end if;

  return query select v_import_id, v_inserted, v_skipped, v_suspected,
    v_income, v_expense, v_inserted_amount, v_skipped_amount, v_suspected_amount;
end;
$$;
