import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseStatementImportGateway } from "@/lib/statements/gateway";
import { importStatementCsv } from "@/lib/statements/import";
import { createUserClient } from "@/lib/supabase/server";

// 明細 CSV の上限（月数百件の明細なら十分）
const MAX_BYTES = 5 * 1024 * 1024;

const formSchema = z.object({
  walletId: z.string().uuid(),
  formatId: z.string().min(1),
});

/**
 * 明細 CSV のアップロード（multipart/form-data: file, walletId, formatId）。
 * 担当者の権限で登録するので、担当外の顧客には RLS で登録できない。外部への書込はしない。
 */
export async function POST(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await context.params;
  if (!z.string().uuid().safeParse(customerId).success) {
    return NextResponse.json({ error: "顧客IDが不正です" }, { status: 400 });
  }

  const supabase = await createUserClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
  }

  const form = await request.formData();
  const fields = formSchema.safeParse({ walletId: form.get("walletId"), formatId: form.get("formatId") });
  const file = form.get("file");
  if (!fields.success || !(file instanceof File)) {
    return NextResponse.json({ error: "file・walletId・formatId を指定してください" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "ファイルが大きすぎます（5MB まで）" }, { status: 413 });
  }

  const result = await importStatementCsv(
    {
      customerId,
      walletId: fields.data.walletId,
      fileName: file.name,
      formatId: fields.data.formatId,
      bytes: new Uint8Array(await file.arrayBuffer()),
    },
    supabaseStatementImportGateway(supabase),
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
