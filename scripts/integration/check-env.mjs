/*
 * 段階12（docs/integration-check.md）の前に、.env.local のキーがそろっているかだけを確かめる。値は表示しない。
 * 実行: node scripts/integration/check-env.mjs
 *
 * - 必要なキー: 値が入っているか（「設定あり」「空」「なし」だけを出す）
 * - 段階12では Claude API を呼ばないため、ANTHROPIC_API_KEY と CRON_SECRET は空にしておく（入っていたら NG）。
 *   CRON_SECRET が空なら候補生成 API（/api/cron/propose）は必ず 401 になり、誤って呼んでも本物の AI に届かない
 * - Supabase の URL は https://<Reference ID>.supabase.co の形かだけを確かめる
 */
import fs from "node:fs";

const file = ".env.local";
if (!fs.existsSync(file)) {
  console.error(`${file} がありません。cp .env.example .env.local で作り、値は自分で入力してください（チャットには貼らない）`);
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const state = (k) => (!(k in env) ? "なし" : env[k] === "" ? "空" : "設定あり");

const rows = [];
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_LOGIN_DOMAIN"]) {
  rows.push({ key: k, state: state(k), expected: "設定あり", ok: state(k) === "設定あり" });
}
for (const k of ["ANTHROPIC_API_KEY", "CRON_SECRET"]) {
  rows.push({ key: k, state: state(k), expected: "空（段階12では Claude API を呼ばない）", ok: state(k) !== "設定あり" });
}
const url = env.NEXT_PUBLIC_SUPABASE_URL || "";
rows.push({
  key: "NEXT_PUBLIC_SUPABASE_URL の形",
  state: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ? "https://<Reference ID>.supabase.co" : "形が違う",
  expected: "https://<Reference ID>.supabase.co（末尾の / や /rest/v1 なし）",
  ok: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url),
});
console.table(rows);
const ng = rows.filter((r) => !r.ok);
if (ng.length) {
  console.error(`NG: ${ng.map((r) => r.key).join("、")}`);
  process.exit(1);
}
console.log("OK: キーはそろっています（値は表示していません）");
