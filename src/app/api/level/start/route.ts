import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { jobId, division, subdivisionId } = await req.json().catch(() => ({} as { jobId?: string; division?: string; subdivisionId?: string }));
  if (!jobId) return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { global: { headers: { Authorization: auth } } });
  const { data: user } = await supabase.auth.getUser();
  const userId = user.user?.id;
  if (!userId) return NextResponse.json({ error: 'No session' }, { status: 401 });

  const payload: Record<string, unknown> = {
    user_id: userId,
    job_id: jobId,
    stage: 'queued',
    state: 'queued',
    status: 'queued',
    progress: 0,
    meta: { division, subdivisionId }
  };
  const { data, error } = await supabase.from('processing_jobs').insert(payload).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, job_id: (data as { id: string }).id });
}
