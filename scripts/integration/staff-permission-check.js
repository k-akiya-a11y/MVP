/*
 * 実結合の確認用: 担当者本人の認証で、画面を通さずに API / RPC を直接呼び、拒否されることを確かめる。
 * docs/integration-check.md「段階10」の手順で、担当者のブラウザの開発者ツール（Console）から実行する。
 *
 * - 認証は、ログイン中の担当者のセッション cookie から取り出したアクセストークンだけを使う。
 *   service_role や SQL Editor の管理者権限は使わない。
 * - トークン・キーは画面にも結果にも出さない。結果に出すのは、操作・期待・HTTP 状態・エラー文・判定だけ。
 * - 書込を試す操作はすべて「拒否されるはず」のもの。もし通った場合は FAIL と表示する。
 * - 実行前後で、担当顧客の明細の状態と確認ログの件数を比べ、変わっていないことも確かめる。
 */
(async () => {
  // ---- 接続先（どちらも公開されている値。秘密ではない）。ファイルは書き換えずに貼り、実行時に入力する ----
  const SUPABASE_URL = (window.prompt("Supabase の Project URL（https://<Reference ID>.supabase.co）") || "").trim().replace(/\/+$/, "");
  const ANON_KEY = (window.prompt("NEXT_PUBLIC_SUPABASE_ANON_KEY の値") || "").trim();
  // ---- seed の架空データの ID ----
  const CUSTOMER_A = "10000000-0000-4000-8000-000000000001"; // 担当: サンプル商事株式会社
  const CUSTOMER_B = "10000000-0000-4000-8000-000000000002"; // 担当外: テスト工房合同会社
  const WALLET_A = "20000000-0000-4000-8000-000000000001";

  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SUPABASE_URL) || !ANON_KEY || ANON_KEY.includes("<")) {
    console.error("Project URL（https://<Reference ID>.supabase.co、/rest/v1 は付けない）と ANON_KEY を入力してください");
    return;
  }
  console.log(`接続先: ${SUPABASE_URL}`);

  // ---- ログイン中のセッションからアクセストークンを取り出す（@supabase/ssr の cookie。分割されていれば結合） ----
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const base = `sb-${ref}-auth-token`;
  const jar = Object.fromEntries(
    document.cookie.split("; ").filter(Boolean).map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
    }),
  );
  let raw = jar[base];
  if (raw === undefined) {
    const parts = [];
    for (let i = 0; jar[`${base}.${i}`] !== undefined; i++) parts.push(jar[`${base}.${i}`]);
    raw = parts.length ? parts.join("") : undefined;
  }
  if (!raw) {
    console.error("ログイン中のセッションが見つかりません。担当者としてログインした画面で実行してください");
    return;
  }
  if (raw.startsWith("base64-")) {
    const b64 = raw.slice(7).replace(/-/g, "+").replace(/_/g, "/");
    raw = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
  }
  const accessToken = JSON.parse(raw).access_token;

  const userHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const anonHeaders = { apikey: ANON_KEY, "Content-Type": "application/json" };

  async function call(method, path, headers, body, extra = {}) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}${path}`, {
        method,
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // 通信そのものの失敗（URL の誤り・ネットワーク・拡張機能による遮断など）。どの呼出しかを出して止める
      console.error(`通信に失敗しました: ${method} ${path.split("?")[0]}（${e && e.message}）`);
      throw e;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* JSON でない応答 */
    }
    return { status: res.status, json, text };
  }
  const rpc = (fn, args, headers = userHeaders) => call("POST", `/rest/v1/rpc/${fn}`, headers, args);
  const select = (q, headers = userHeaders) => call("GET", `/rest/v1/${q}`, headers);

  const results = [];
  const errText = (r) => (r.json && (r.json.message || r.json.error || r.json.msg)) || r.text.slice(0, 120);
  function record(id, who, operation, expected, r, pass) {
    results.push({ id, who, operation, expected, http: r.status, actual: errText(r) || "(本文なし)", result: pass ? "PASS" : "FAIL" });
  }
  // 拒否されたか: HTTP がエラーで、期待する文言を含む
  const rejected = (r, words) => r.status >= 400 && words.some((w) => (errText(r) || "").includes(w));
  const emptyArray = (r) => r.status === 200 && Array.isArray(r.json) && r.json.length === 0;

  // ---- 本人と役割の確認 ----
  const me = await call("GET", "/auth/v1/user", userHeaders);
  const myId = me.json && me.json.id;
  const myRow = await select(`staff_members?select=role,display_name&user_id=eq.${myId}`);
  const myRole = myRow.json && myRow.json[0] && myRow.json[0].role;
  console.log(`実行者: ${myRow.json?.[0]?.display_name ?? "?"}（役割: ${myRole ?? "?"}）`);
  if (myRole !== "staff") {
    console.error("担当者（staff）のアカウントで実行してください。管理者では権限の確認になりません");
    return;
  }

  // ---- 実行前の状態（担当顧客の明細の状態・確認ログ・重複の確認ログ） ----
  async function snapshot() {
    const txns = await select(`bank_transactions?select=id,status&customer_id=eq.${CUSTOMER_A}&order=id`);
    const reviews = await select(`human_reviews?select=id&customer_id=eq.${CUSTOMER_A}`);
    const dups = await select(`duplicate_reviews?select=id&customer_id=eq.${CUSTOMER_A}`);
    const imports = await select(`statement_imports?select=id&customer_id=eq.${CUSTOMER_A}`);
    return {
      statuses: JSON.stringify(txns.json),
      txnCount: txns.json.length,
      reviewCount: reviews.json.length,
      duplicateReviewCount: dups.json.length,
      importCount: imports.json.length,
    };
  }
  const before = await snapshot();

  // ---- 対象の選定（担当顧客の、確認待ちの最新の仕訳候補） ----
  // 「高」が確認待ちに残っていなければ、保留中の「高」で試す（担当者は状態に関係なく管理者の判定で拒否される）
  const open = await select(`bank_transactions?select=id,status&customer_id=eq.${CUSTOMER_A}&status=in.(proposed,on_hold)`);
  const proposedIds = (open.json || []).filter((t) => t.status === "proposed").map((t) => t.id);
  const openIds = (open.json || []).map((t) => t.id);
  let target = null;
  let highTarget = null;
  if (openIds.length) {
    const decisions = await select(
      `latest_ai_decisions?select=id,confidence,bank_transaction_id&bank_transaction_id=in.(${openIds.join(",")})`,
    );
    const list = decisions.json || [];
    target = list.find((d) => proposedIds.includes(d.bank_transaction_id)) || null;
    highTarget =
      list.find((d) => d.confidence === "high" && proposedIds.includes(d.bank_transaction_id)) ||
      list.find((d) => d.confidence === "high") ||
      null;
  }
  const suspected = await select(
    `bank_transactions?select=id&customer_id=eq.${CUSTOMER_A}&status=eq.duplicate_suspected&limit=1`,
  );
  const suspectedId = suspected.json && suspected.json[0] && suspected.json[0].id;
  const ADMIN_ONLY = ["承認者（管理者）だけ"];

  // ---- 担当者の認証で、確定につながる操作を直接呼ぶ ----
  if (target) {
    const args = { p_ai_decision_id: target.id, p_final_entry: null, p_reason: null, p_review_seconds: 1, p_bulk: false };
    let r = await rpc("record_human_review", { ...args, p_action: "approve" });
    record("S-1", "担当者", "承認（RPC）", "拒否（管理者だけ）", r, rejected(r, ADMIN_ONLY));
    r = await rpc("record_human_review", {
      ...args,
      p_action: "correct",
      p_final_entry: { account_item_id: 101, tax_code: 21, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "権限確認" },
    });
    record("S-2", "担当者", "修正（RPC）", "拒否（管理者だけ）", r, rejected(r, ADMIN_ONLY));
    r = await rpc("record_human_review", { ...args, p_action: "reject", p_reason: "権限確認" });
    record("S-3", "担当者", "却下（RPC）", "拒否（管理者だけ）", r, rejected(r, ADMIN_ONLY));
    r = await rpc("record_human_review", { ...args, p_action: "hold", p_reason: " 　\n" });
    record("S-5", "担当者", "空白だけの理由で保留（RPC）", "拒否（理由が必要）", r, rejected(r, ["保留の理由を入力してください"]));
  } else {
    results.push({ id: "S-1〜3,5", who: "担当者", operation: "承認・修正・却下・空白理由の保留", expected: "-", http: "-", actual: "確認待ちの候補がないため実行せず", result: "SKIP" });
  }
  if (highTarget) {
    const r = await rpc("record_human_review", {
      p_ai_decision_id: highTarget.id, p_action: "approve", p_final_entry: null, p_reason: null, p_review_seconds: 1, p_bulk: true,
    });
    record("S-4", "担当者", "まとめて承認（RPC、bulk=true、確信度「高」）", "拒否（管理者だけ）", r, rejected(r, ADMIN_ONLY));
  } else {
    results.push({ id: "S-4", who: "担当者", operation: "まとめて承認", expected: "-", http: "-", actual: "確認待ち・保留中の「高」がないため実行せず", result: "SKIP" });
  }
  if (suspectedId) {
    const r = await rpc("resolve_suspected_duplicate", { p_bank_transaction_id: suspectedId, p_resolution: "duplicate", p_reason: "権限確認" });
    record("S-6", "担当者", "重複として除外（RPC）", "拒否（管理者だけ）", r, rejected(r, ADMIN_ONLY));
  }

  // ---- 表への直接の書込（関数を通さない） ----
  let r = await call("POST", "/rest/v1/human_reviews", userHeaders, {
    customer_id: CUSTOMER_A, ai_decision_id: target ? target.id : CUSTOMER_A, action: "approve", reviewer_id: myId, bulk: false, diff: {},
  });
  record("S-7", "担当者", "確認ログへ直接 INSERT", "拒否", r, r.status >= 400);
  r = await call("PATCH", `/rest/v1/bank_transactions?customer_id=eq.${CUSTOMER_A}&status=eq.proposed`, userHeaders, { status: "approved" }, { Prefer: "return=representation" });
  record("S-8", "担当者", "明細の状態を直接 UPDATE（approved に）", "拒否、または0行", r, r.status >= 400 || emptyArray(r));
  r = await call("PATCH", `/rest/v1/staff_members?user_id=eq.${myId}`, userHeaders, { role: "admin" }, { Prefer: "return=representation" });
  record("S-9", "担当者", "自分の役割を admin に UPDATE", "拒否、または0行", r, r.status >= 400 || emptyArray(r));
  r = await call("POST", "/rest/v1/customer_assignments", userHeaders, { customer_id: CUSTOMER_B, user_id: myId });
  record("S-10", "担当者", "担当外の顧客を自分に割り当てる INSERT", "拒否", r, r.status >= 400);

  // ---- 担当外の顧客の閲覧 ----
  r = await select(`customers?select=id,name&id=eq.${CUSTOMER_B}`);
  record("S-11", "担当者", "担当外の顧客を SELECT", "0行", r, emptyArray(r));
  r = await select(`bank_transactions?select=id&customer_id=eq.${CUSTOMER_B}`);
  record("S-12", "担当者", "担当外の顧客の明細を SELECT", "0行", r, emptyArray(r));
  r = await select(`ai_decisions?select=id&customer_id=eq.${CUSTOMER_B}`);
  record("S-13", "担当者", "担当外の顧客の判断ログを SELECT", "0行", r, emptyArray(r));
  r = await select(`past_journal_entries?select=id&customer_id=eq.${CUSTOMER_B}`);
  record("S-14", "担当者", "担当外の顧客の過去仕訳を SELECT", "0行", r, emptyArray(r));

  // ---- 担当外の顧客への明細取込 ----
  const row = { txn_date: "2026-11-01", amount: 1, direction: "expense", description: "権限確認", balance: null, dedupe_key: `perm-check-${Date.now()}` };
  r = await rpc("import_bank_statement", {
    p_customer_id: CUSTOMER_B, p_wallet_id: WALLET_A, p_source: "csv", p_file_name: "perm.csv", p_csv_format: "bank_generic",
    p_rows: [row], p_source_row_count: 1, p_ignored_rows: [],
  });
  record("S-15", "担当者", "担当外の顧客へ明細取込（RPC）", "拒否（担当外）", r, rejected(r, ["担当外の顧客には明細を取り込めません"]));
  r = await rpc("record_failed_statement_import", {
    p_customer_id: CUSTOMER_B, p_wallet_id: WALLET_A, p_source: "csv", p_file_name: "perm.csv", p_csv_format: "bank_generic",
    p_source_row_count: 1, p_errors: [{ line: 1, message: "権限確認" }],
  });
  record("S-16", "担当者", "担当外の顧客へ失敗記録（RPC）", "拒否（担当外）", r, rejected(r, ["担当外の顧客には明細を取り込めません"]));
  r = await call("POST", "/rest/v1/bank_transactions", userHeaders, { ...row, customer_id: CUSTOMER_B, wallet_id: WALLET_A });
  record("S-17", "担当者", "担当外の顧客の明細へ直接 INSERT", "拒否", r, r.status >= 400);
  const csv = new Blob(["日付,摘要,出金,入金,残高\n2026/11/01,ｹﾝｹﾞﾝｶｸﾆﾝ,1,,1\n"], { type: "text/csv" });
  const form = new FormData();
  form.append("file", csv, "perm.csv");
  form.append("walletId", WALLET_A);
  form.append("formatId", "bank_generic");
  let appRes = await fetch(`/api/customers/${CUSTOMER_B}/statements`, { method: "POST", body: form });
  let appText = await appRes.text();
  results.push({
    id: "S-18", who: "担当者", operation: "アプリの取込 API で担当外の顧客へ取込", expected: "拒否",
    http: appRes.status, actual: appText.slice(0, 120), result: appRes.status >= 400 && !appText.includes('"ok":true') ? "PASS" : "FAIL",
  });

  // ---- 未認証（ログインなし。公開の anon キーだけ） ----
  if (target) {
    r = await rpc("record_human_review", {
      p_ai_decision_id: target.id, p_action: "approve", p_final_entry: null, p_reason: null, p_review_seconds: 1, p_bulk: false,
    }, anonHeaders);
    record("U-1", "未認証", "承認（RPC）", "拒否", r, r.status >= 400);
  }
  r = await rpc("import_bank_statement", {
    p_customer_id: CUSTOMER_A, p_wallet_id: WALLET_A, p_source: "csv", p_file_name: "perm.csv", p_csv_format: "bank_generic",
    p_rows: [row], p_source_row_count: 1, p_ignored_rows: [],
  }, anonHeaders);
  record("U-2", "未認証", "明細取込（RPC）", "拒否", r, r.status >= 400);
  r = await select(`customers?select=id`, anonHeaders);
  record("U-3", "未認証", "顧客を SELECT", "拒否、または0行", r, r.status >= 400 || emptyArray(r));
  r = await select(`bank_transactions?select=id`, anonHeaders);
  record("U-4", "未認証", "明細を SELECT", "拒否、または0行", r, r.status >= 400 || emptyArray(r));
  r = await select(`ai_decisions?select=id`, anonHeaders);
  record("U-5", "未認証", "判断ログを SELECT", "拒否、または0行", r, r.status >= 400 || emptyArray(r));
  const form2 = new FormData();
  form2.append("file", csv, "perm.csv");
  form2.append("walletId", WALLET_A);
  form2.append("formatId", "bank_generic");
  appRes = await fetch(`/api/customers/${CUSTOMER_A}/statements`, { method: "POST", body: form2, credentials: "omit" });
  appText = await appRes.text();
  results.push({
    id: "U-6", who: "未認証", operation: "アプリの取込 API（cookie なし）", expected: "拒否（401）",
    http: appRes.status, actual: appText.slice(0, 120), result: appRes.status === 401 ? "PASS" : "FAIL",
  });
  appRes = await fetch(`/api/cron/propose`, { credentials: "omit" });
  appText = await appRes.text();
  results.push({
    id: "U-7", who: "未認証", operation: "候補生成 API（CRON_SECRET なし）", expected: "拒否（401）",
    http: appRes.status, actual: appText.slice(0, 120), result: appRes.status === 401 ? "PASS" : "FAIL",
  });

  // ---- 実行後の状態が変わっていないこと ----
  const after = await snapshot();
  const same = (k) => before[k] === after[k];
  results.push({
    id: "S-19", who: "担当者", operation: "実行前後の比較（明細の状態・件数、確認ログ、重複の確認ログ、取込記録）", expected: "変化なし",
    http: "-",
    actual: `明細 ${before.txnCount}→${after.txnCount}件、状態 ${same("statuses") ? "同じ" : "変化あり"}、確認ログ ${before.reviewCount}→${after.reviewCount}件、重複の確認ログ ${before.duplicateReviewCount}→${after.duplicateReviewCount}件、取込記録 ${before.importCount}→${after.importCount}件`,
    result: ["statuses", "txnCount", "reviewCount", "duplicateReviewCount", "importCount"].every(same) ? "PASS" : "FAIL",
  });

  console.table(results);
  const summary = { executedAt: new Date().toISOString(), origin: location.origin, role: myRole, results };
  window.__permissionCheck = summary;
  console.log("結果をコピーするには、次を入力して Enter: copy(JSON.stringify(window.__permissionCheck, null, 2))");
})();
