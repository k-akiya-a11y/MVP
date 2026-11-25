/*
 * 段階12（docs/integration-check.md）で、アプリが実際に使う環境変数（実効値）を確かめる。値は表示しない。
 * 実行: npm run verify:start（このチェックが OK のときだけ next start する）。単独なら node scripts/integration/check-env.mjs
 *
 * 実効値は Next.js と同じ順で決める: 起動元の環境変数 > .env.production.local > .env.local > .env.production > .env
 * （起動元のシェルに残っている値は .env.local より優先されるため、ファイルだけを見ても足りない）
 * - 必要なキー: 値が入っているか（「設定あり」「空」「なし」と、どこから来た値かだけを出す）
 * - 段階12では Claude API を呼ばないため、ANTHROPIC_API_KEY と CRON_SECRET は空であること（入っていたら NG）。
 *   CRON_SECRET が空なら候補生成 API（/api/cron/propose）は必ず 401 になり、誤って呼んでも本物の AI に届かない
 * - 接続先の Supabase の Reference ID が scripts/integration/verification-projects.json の一覧にあること
 *   （一覧は PR で追加し、本番でないことをレビューで確かめる。接続先の設定とは別に決めた値と照合する）
 */
import fs from "node:fs";

const FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

function parse(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
const fileValues = FILES.map((f) => [f, parse(f)]);

/** 実効値と、その出どころ（値そのものは返すが表示はしない） */
function effective(key) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return { value: process.env[key] ?? "", from: "起動元の環境変数" };
  for (const [file, values] of fileValues) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return { value: values[key], from: file };
  }
  return { value: undefined, from: "-" };
}
const state = (e) => (e.value === undefined ? "なし" : e.value === "" ? "空" : "設定あり");

const allowlistFile = new URL("./verification-projects.json", import.meta.url);
const allowed = JSON.parse(fs.readFileSync(allowlistFile, "utf8")).allowedProjectRefs;
if (!Array.isArray(allowed) || !allowed.every((r) => typeof r === "string" && /^[a-z0-9]+$/.test(r))) {
  console.error("verification-projects.json の allowedProjectRefs が正しくありません");
  process.exit(1);
}

const rows = [];
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_LOGIN_DOMAIN"]) {
  const e = effective(k);
  rows.push({ key: k, state: state(e), from: e.from, expected: "設定あり", ok: state(e) === "設定あり" });
}
for (const k of ["ANTHROPIC_API_KEY", "CRON_SECRET"]) {
  const e = effective(k);
  rows.push({ key: k, state: state(e), from: e.from, expected: "空かなし（段階12では Claude API を呼ばない）", ok: state(e) !== "設定あり" });
}
const url = effective("NEXT_PUBLIC_SUPABASE_URL").value ?? "";
const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url);
rows.push({
  key: "接続先の形",
  state: m ? "https://<Reference ID>.supabase.co" : "形が違う",
  from: "-",
  expected: "https://<Reference ID>.supabase.co（末尾の / や /rest/v1 なし）",
  ok: Boolean(m),
});
rows.push({
  key: "接続先が検証専用の一覧にある",
  state: m ? (allowed.includes(m[1]) ? "一覧にある" : "一覧にない") : "-",
  from: "verification-projects.json",
  expected: "一覧にある",
  ok: Boolean(m) && allowed.includes(m[1]),
});
console.table(rows);
const ng = rows.filter((r) => !r.ok);
if (ng.length) {
  console.error(`NG: ${ng.map((r) => r.key).join("、")}（起動元の環境変数が優先されます。シェルに残っている値も確かめてください）`);
  process.exit(1);
}
console.log("OK: 実効値を確かめました（値は表示していません）");
