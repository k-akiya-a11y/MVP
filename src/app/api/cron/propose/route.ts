import { NextResponse } from "next/server";
import { proposeJournalEntriesJob } from "@/jobs/propose-journal-entries";

// AI 呼出しを含むので長めに取る
export const maxDuration = 300;

/** Vercel Cron から呼ぶ（Authorization: Bearer CRON_SECRET） */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await proposeJournalEntriesJob();
  return NextResponse.json(result);
}
