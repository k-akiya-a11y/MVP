/*
 * 段階12（docs/integration-check.md）で、アプリが実際に使う環境変数（実効値）を確かめる。値は表示しない。
 * 通常は npm run verify:start（scripts/integration/verify-start.mjs）から呼ばれ、OK のときだけ同じ環境でビルドと起動をする。
 * 単独で確かめるだけなら node scripts/integration/check-env.mjs
 *
 * 実効値は Next.js 自身のローダー（@next/env の loadEnvConfig、本番モード）で決める。起動元の環境変数が .env.* より優先され、
 * 変数の展開（$VAR）や複数行の値も Next.js と同じに扱われる（手書きの読み取りでは一致しないため）。
 * - 必要なキー: 値が入っているか（「設定あり」「空」「なし」と、どこから来た値かだけを出す）
 * - 段階12では Claude API を呼ばないため、ANTHROPIC_API_KEY と CRON_SECRET は空であること（入っていたら NG）。
 *   CRON_SECRET が空なら候補生成 API（/api/cron/propose）は必ず 401 になり、誤って呼んでも本物の AI に届かない
 * - 接続先の Supabase の Reference ID が scripts/integration/verification-projects.json の一覧にあること
 *   （一覧は PR で追加し、本番でないことをレビューで確かめる。接続先の設定とは別に決めた値と照合する）
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_LOGIN_DOMAIN"];
const MUST_BE_EMPTY = ["ANTHROPIC_API_KEY", "CRON_SECRET"];

/**
 * process.env に Next.js と同じ規則で .env.* を読み込み（既にある値は上書きしない）、実効値を確かめる。
 * 呼んだ後の process.env が、そのままビルドと起動に渡す環境になる
 */
export function checkEffectiveEnv(dir = process.cwd()) {
  // next build・next start と同じく本番モードで読む（NODE_ENV=test などが残っていると、読むファイルが変わるため）
  process.env.NODE_ENV = "production";
  const inherited = new Set(Object.keys(process.env));
  const { loadedEnvFiles } = loadEnvConfig(dir, false, { info: () => undefined, error: (...a) => console.error(...a) }, true);
  const from = (key) => {
    if (inherited.has(key)) return "起動元の環境変数";
    const f = loadedEnvFiles.find((file) => Object.prototype.hasOwnProperty.call(file.env, key));
    return f ? f.path : "-";
  };
  const state = (key) => {
    const v = process.env[key];
    return v === undefined ? "なし" : v === "" ? "空" : "設定あり";
  };

  const allowlistFile = new URL("./verification-projects.json", import.meta.url);
  const allowed = JSON.parse(fs.readFileSync(allowlistFile, "utf8")).allowedProjectRefs;
  if (!Array.isArray(allowed) || !allowed.every((r) => typeof r === "string" && /^[a-z0-9]+$/.test(r))) {
    throw new Error("verification-projects.json の allowedProjectRefs が正しくありません");
  }

  const rows = [];
  for (const k of REQUIRED) rows.push({ key: k, state: state(k), from: from(k), expected: "設定あり", ok: state(k) === "設定あり" });
  for (const k of MUST_BE_EMPTY) {
    rows.push({ key: k, state: state(k), from: from(k), expected: "空かなし（段階12では Claude API を呼ばない）", ok: state(k) !== "設定あり" });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url);
  rows.push({
    key: "接続先の形",
    state: m ? "https://<Reference ID>.supabase.co" : "形が違う",
    from: from("NEXT_PUBLIC_SUPABASE_URL"),
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
  return { ok: rows.every((r) => r.ok), rows };
}

export function printResult({ ok, rows }) {
  console.table(rows);
  if (!ok) {
    const ng = rows.filter((r) => !r.ok).map((r) => r.key);
    console.error(`NG: ${ng.join("、")}（起動元の環境変数は .env.* より優先されます。シェルに残っている値も確かめてください）`);
  } else {
    console.log("OK: 実効値を確かめました（値は表示していません）");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkEffectiveEnv();
  printResult(result);
  process.exit(result.ok ? 0 : 1);
}
