import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 段階12の起動前チェック（scripts/integration/check-env.mjs）。実効値（起動元の環境変数 > .env.* ファイル）で判定し、値は表示しないこと
const SCRIPT = resolve("scripts/integration/check-env.mjs");
const SECRET = "sk-should-never-be-printed-0123456789";

function run(files: Record<string, string>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-env-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(NODE_ENV|NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|ALLOWED_LOGIN_DOMAIN|ANTHROPIC_API_KEY|CRON_SECRET)$/.test(k),
    ),
  );
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const goodLocal = [
  "NEXT_PUBLIC_SUPABASE_URL=https://abcdefghij.supabase.co",
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${SECRET}`,
  `SUPABASE_SERVICE_ROLE_KEY=${SECRET}`,
  "ALLOWED_LOGIN_DOMAIN=example.jp",
  "ANTHROPIC_API_KEY=",
  "CRON_SECRET=",
].join("\n");

describe("段階12の起動前チェック（check-env.mjs）", () => {
  it("検証専用の一覧にない接続先は NG（一覧が空のあいだは必ず止まる）", () => {
    const r = run({ ".env.local": goodLocal });
    expect(r.code).toBe(1);
    expect(r.out).toContain("接続先が検証専用の一覧にある");
    expect(r.out).not.toContain(SECRET);
  });

  it("起動元の環境変数に残った CRON_SECRET・ANTHROPIC_API_KEY を、ファイルが空でも NG にする（値は出さない）", () => {
    const r = run({ ".env.local": goodLocal }, { CRON_SECRET: SECRET, ANTHROPIC_API_KEY: SECRET });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NG: .*ANTHROPIC_API_KEY.*CRON_SECRET/);
    expect(r.out).toContain("起動元の環境変数");
    expect(r.out).not.toContain(SECRET);
  });

  it("起動元の環境変数の接続先が .env.local より優先される", () => {
    const r = run({ ".env.local": goodLocal }, { NEXT_PUBLIC_SUPABASE_URL: "https://example.com/rest/v1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("形が違う");
  });

  it("Next.js と同じく変数の展開（$VAR）を解決して判定する", () => {
    const r = run({ ".env.local": `${goodLocal}
REAL_KEY=${SECRET}
`.replace("CRON_SECRET=", "CRON_SECRET=$REAL_KEY") });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NG: .*CRON_SECRET/);
    expect(r.out).not.toContain(SECRET);
  });

  it("NODE_ENV=test が残っていても、本番モードと同じファイル（.env.local）を読む", () => {
    const r = run({ ".env.local": `${goodLocal.replace("CRON_SECRET=", `CRON_SECRET=${SECRET}`)}
` }, { NODE_ENV: "test" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NG: .*CRON_SECRET/);
  });

  it(".env.production.local の値も実効値として見る（.env.local より優先）", () => {
    const r = run({ ".env.local": goodLocal, ".env.production.local": `CRON_SECRET=${SECRET}\n` });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NG: .*CRON_SECRET/);
    expect(r.out).not.toContain(SECRET);
  });
});
