import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { extractFromBuffer, type ExtractedItem } from "@/lib/serverExtract";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

type Report = {
  division_code: string | null;
  subdivision_id?: string | null;
  contractors: Array<{ contractor_id: string | null; name: string; total?: number | null }>;
  scope_items: string[];
  matrix: Record<string, Record<string, { status: "included" | "excluded" | "not_specified"; price?: number | null }>>;
  qualifications: Record<string, { includes: string[]; excludes: string[]; allowances: string[]; alternates: string[]; payment_terms?: string[]; fine_print?: string[] }>;
  recommendation?: { selected_contractor_id?: string | null; rationale?: string; next_steps?: string } | string;
};

export async function POST(req: NextRequest) {
  try {
    const { jobId, division, subdivisionId } = await req.json().catch(() => ({} as { jobId?: string; division?: string; subdivisionId?: string }));
    if (!jobId) return new Response(JSON.stringify({ error: "Missing jobId" }), { status: 400 });

    const auth = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!auth) return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });

    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { global: { headers: { Authorization: auth } } });

    let bidsQuery = supabase
      .from('bids')
      .select('id, user_id, contractor_id, job_id, division_code, subdivision_id')
      .eq('job_id', jobId);
    if (subdivisionId) {
      bidsQuery = bidsQuery.eq('subdivision_id', subdivisionId);
    } else {
      bidsQuery = bidsQuery.eq('division_code', division || null).is('subdivision_id', null);
    }
    const { data: bids } = await bidsQuery;
    const bidList = bids || [];
    if (!bidList.length) return new Response(JSON.stringify({ error: "No bids found for this division." }), { status: 404 });

    const contractorIds = Array.from(new Set(bidList.map(b => b.contractor_id).filter(Boolean))) as string[];
    const contractors: Record<string, string> = {};
    if (contractorIds.length) {
      const { data: cons } = await supabase.from('contractors').select('id,name').in('id', contractorIds);
      (cons || []).forEach(c => { contractors[c.id] = c.name; });
    }

    const byBid: Record<string, ExtractedItem[]> = {};
    for (const b of bidList) {
      const { data: docs } = await supabase.from('documents').select('storage_path').eq('bid_id', b.id);
      const items: ExtractedItem[] = [];
      for (const d of (docs || [])) {
        const { data: blob } = await supabase.storage.from('bids').download(d.storage_path);
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const ex = await extractFromBuffer(d.storage_path, buf);
        for (const it of ex) { items.push(it); if (items.length >= 1500) break; }
        if (items.length >= 1500) break;
      }
      byBid[b.id] = items;
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return new Response(JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY" }), { status: 500 });
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Build prompt with per-contractor snippets
    const promptPayload = bidList.slice(0, 6).map(b => ({
      bid_id: b.id,
      contractor_name: b.contractor_id ? (contractors[b.contractor_id] || 'Contractor') : 'Contractor',
      items: (byBid[b.id] || []).slice(0, 300)
    }));

    const system = `You are a seasoned Construction Executive performing bid leveling for a single CSI division (or a sub-division). You must:
- Build a comprehensive list of scope items from all bids' content.
- For each contractor, mark each scope item as included, excluded, or not_specified; include priced amounts when present.
- Summarize qualifications: includes, excludes, allowances, alternates, payment terms, and any pertinent fine print.
- Provide a brief recommendation (selected contractor, rationale, next steps).
Output strict JSON only.`;

    const userMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `Division: ${division || ''}${subdivisionId ? `\nSubdivision: ${subdivisionId}` : ''}\nBids: ${JSON.stringify(promptPayload).slice(0, 20000)}\n\nDesired JSON format:\n${JSON.stringify({
        division_code: division || null,
        subdivision_id: subdivisionId || null,
        contractors: [{ contractor_id: '...', name: '...', total: 0 }],
        scope_items: ['...'],
        matrix: { '<scope>': { '<contractor_id>': { status: 'included', price: 0 } } },
        qualifications: { '<contractor_id>': { includes: [], excludes: [], allowances: [], alternates: [], payment_terms: [], fine_print: [] } },
        recommendation: { selected_contractor_id: '...', rationale: '...', next_steps: '...' }
      }, null, 2)}` }]
    };

    const resp = await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 4000, temperature: 0.2, system, messages: [userMsg] });
    const block = Array.isArray(resp.content)
      ? (resp.content.find((b: unknown) => {
          if (typeof b !== 'object' || b === null) return false;
          const r = b as Record<string, unknown>;
          return r['type'] === 'text' && typeof r['text'] === 'string';
        }) as { type: string; text?: string } | undefined)
      : undefined;
    const content = block?.text || '{}';
    let parsed: Report;
    try { parsed = JSON.parse(content) as Report; } catch { return new Response(JSON.stringify({ error: 'AI returned invalid JSON' }), { status: 502 }); }

    // Persist report
    const { data: user } = await supabase.auth.getUser();
    const userId = user.user?.id;
    await supabase.from('bid_level_reports').insert({ user_id: userId, job_id: jobId, division_code: division || null, subdivision_id: subdivisionId || null, report: parsed });

    return new Response(JSON.stringify({ ok: true, scope_count: parsed.scope_items?.length || 0 }), { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
