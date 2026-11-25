/*
 * 段階12の起動（npm run verify:start）。実効値を確かめ、OK のときだけ、確かめたのと同じ環境（この process.env）で
 * next build と next start を続けて行う。
 *
 * ビルドをやり直す理由: NEXT_PUBLIC_ で始まる値（Supabase の URL など）はビルドの時点でブラウザ用のコードに埋め込まれる。
 * 以前に別の値でビルドした .next を使うと、起動時の値が検証用でも、ブラウザは別のプロジェクトにつながりうる。
 * 古い .next は消してからビルドする。
 */
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { checkEffectiveEnv, printResult } from "./check-env.mjs";

const result = checkEffectiveEnv();
printResult(result);
if (!result.ok) process.exit(1);

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
// 確かめた値をそのまま子プロセスに渡す（ここから先で環境を変えない）
const env = { ...process.env, NODE_ENV: "production" };

fs.rmSync(".next", { recursive: true, force: true });
const build = spawnSync(process.execPath, [nextBin, "build"], { env, stdio: "inherit" });
if (build.status !== 0) {
  console.error("ビルドに失敗しました");
  process.exit(build.status ?? 1);
}
const start = spawn(process.execPath, [nextBin, "start"], { env, stdio: "inherit" });
start.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => start.kill(sig));
