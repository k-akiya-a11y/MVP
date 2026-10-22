import { LoginButton } from "./login-button";

const ERRORS: Record<string, string> = {
  domain: "結乃社の Google アカウントでログインしてください。",
  not_staff: "このアカウントは担当者として登録されていません。管理者に連絡してください。",
  failed: "ログインに失敗しました。もう一度お試しください。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="narrow">
      <h1>結乃社 AI経理</h1>
      {error && <p className="error">{ERRORS[error] ?? ERRORS.failed}</p>}
      <LoginButton hostedDomain={process.env.ALLOWED_LOGIN_DOMAIN ?? ""} />
    </main>
  );
}
