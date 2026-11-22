import Link from "next/link";
import { notFound } from "next/navigation";
import { STATEMENT_CSV_FORMATS } from "@/lib/statements/formats";
import { loadReviewQueue } from "@/lib/review/queue";
import { createUserClient } from "@/lib/supabase/server";
import { DuplicatesPanel } from "./duplicates-panel";
import { ReviewBoard } from "./review-board";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function CustomerReviewPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  let queue: Awaited<ReturnType<typeof loadReviewQueue>> = null;
  let failure = false;
  try {
    queue = await loadReviewQueue(await createUserClient(), customerId);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  // 顧客が見えない（権限外・存在しない）ときは従来どおり 404（catch の外）
  if (!failure && !queue) notFound();

  if (failure || !queue) {
    return (
      <main>
        <p>
          <Link href="/">← 顧客一覧</Link>
        </p>
        <h1>承認待ちの取引</h1>
        <p className="error">
          承認待ちの取引を読み込めなかったため表示できません（「承認待ちがない」ことを意味しません）。時間をおいて再読み込みしてください。この画面では取込・承認などの操作はできません。
        </p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/">← 顧客一覧</Link>
      </p>
      <h1>{queue.customer.name}</h1>
      <p>
        <Link href={`/customers/${customerId}/history`}>確認の履歴を見る</Link>
        {" / "}
        <Link href={`/customers/${customerId}/imports`}>明細CSVの取込の記録を見る</Link>
        {" / "}
        <Link href={`/customers/${customerId}/statements`}>取り込んだ明細の一覧を見る</Link>
        {" / "}
        <Link href={`/customers/${customerId}/past-quality`}>過去仕訳の科目の揺れを確認する</Link>
        {" / "}
        <Link href={`/customers/${customerId}/rules`}>顧客ルールを確認・編集する</Link>
        {" / "}
        <Link href={`/customers/${customerId}/notes`}>文章メモを確認・編集する</Link>
      </p>
      <UploadForm
        customerId={customerId}
        wallets={queue.wallets}
        formats={STATEMENT_CSV_FORMATS.map((f) => ({ id: f.id, label: f.label }))}
      />
      <DuplicatesPanel customerId={customerId} canApprove={queue.canApprove} items={queue.suspectedDuplicates} />
      <ReviewBoard customerId={customerId} canApprove={queue.canApprove} items={queue.items} masters={queue.masters} />
    </main>
  );
}
