import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    // DB テストは同じデータベースを使うので並列にしない
    fileParallelism: false,
    projects: [
      {
        resolve: { alias },
        // tsconfig は Next 用に jsx: preserve のため、Vite の変換にそのまま渡すと
        // ページを import するテストが import analysis で失敗する。unit だけ automatic runtime で変換する
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // 実際の Postgres に対するマイグレーション・RLS のテスト（TEST_DATABASE_URL が必要）
        resolve: { alias },
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
