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
  const queue = await loadReviewQueue(await createUserClient(), customerId);
  if (!queue) notFound();

  return (
    <main>
      <p>
        <Link href="/">← 顧客一覧</Link>
      </p>
      <h1>{queue.customer.name}</h1>
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
