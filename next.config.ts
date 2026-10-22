import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // サーバー側だけで使うモジュールをクライアントに混ぜない
  serverExternalPackages: ["pg"],
};

export default nextConfig;
