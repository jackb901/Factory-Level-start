import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { global: { headers: { Authorization: auth } } });
  const { data, error } = await supabase.from('processing_jobs').select('id,status,progress,batches_total,batches_done,error,started_at,finished_at').eq('id', id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, job: data });
}
