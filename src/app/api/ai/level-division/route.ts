import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
    // Lazy-load heavy dependencies to prevent module init issues on GET/OPTIONS
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const XLSX = await import("xlsx");
    const { jobId, division, subdivisionId } = await req.json().catch(() => ({} as { jobId?: string; division?: string; subdivisionId?: string }));
    const LIMITS = {
      pdfB64PerFile: 250_000,   // ~250 KB base64 per PDF
      csvPerSheet: 50_000,      // chars per sheet
      perBid: 200_000,          // total chars per contractor
      maxContractors: 4,        // cap contractors per call
      maxDocsPerBid: 4          // cap docs per contractor
    } as const;
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
    const { data: bids, error: bidsErr } = await bidsQuery;
    if (bidsErr) return new Response(JSON.stringify({ error: `DB error loading bids: ${bidsErr.message}` }), { status: 500 });
    const bidList = bids || [];
    if (!bidList.length) return new Response(JSON.stringify({ error: `No bids found for ${subdivisionId ? `subdivision ${subdivisionId}` : `division ${division || '(none)'}`}. Create bids and upload documents first.` }), { status: 404 });

    const contractorIds = Array.from(new Set(bidList.map(b => b.contractor_id).filter(Boolean))) as string[];
    const contractors: Record<string, string> = {};
    if (contractorIds.length) {
      const { data: cons } = await supabase.from('contractors').select('id,name').in('id', contractorIds);
      (cons || []).forEach(c => { contractors[c.id] = c.name; });
    }

    const byBidText: Record<string, string> = {};
    for (const b of bidList) {
      const { data: docs, error: docsErr } = await supabase.from('documents').select('storage_path').eq('bid_id', b.id);
      if (docsErr) return new Response(JSON.stringify({ error: `DB error loading documents: ${docsErr.message}` }), { status: 500 });
      let combined = '';
      let docCount = 0;
      for (const d of (docs || [])) {
        if (docCount >= LIMITS.maxDocsPerBid) break;
        const { data: blob, error: dlErr } = await supabase.storage.from('bids').download(d.storage_path);
        if (dlErr) {
          // Skip unreadable files but continue
          continue;
        }
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const lower = d.storage_path.toLowerCase();
        if (lower.endsWith('.pdf')) {
          const b64 = Buffer.from(buf).toString('base64');
          const capped = b64.slice(0, LIMITS.pdfB64PerFile);
          combined += `\n\n=== FILE: ${d.storage_path} (PDF_BASE64, len=${b64.length}, capped=${capped.length < b64.length}) ===\n${capped}`;
        } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
          type XLSXLike = { read: (b: Buffer, o: { type: 'buffer' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_csv: (ws: unknown) => string } };
          const x = XLSX as unknown as XLSXLike;
          const wb = x.read(Buffer.from(buf), { type: 'buffer' });
          for (const wsName of wb.SheetNames) {
            const ws = wb.Sheets[wsName];
            const csv = x.utils.sheet_to_csv(ws);
            const body = String(csv).slice(0, LIMITS.csvPerSheet);
            combined += `\n\n=== FILE: ${d.storage_path} (XLSX) SHEET: ${wsName} ===\n${body}`;
            if (combined.length >= LIMITS.perBid) break;
          }
        } else if (lower.endsWith('.csv')) {
          const text = Buffer.from(buf).toString('utf8');
          // keep original as-is
          combined += `\n\n=== FILE: ${d.storage_path} (CSV) ===\n` + text.slice(0, LIMITS.csvPerSheet);
        } else {
          // Unsupported types: include a stub header so Claude can ignore
          const sample = Buffer.from(buf).toString('utf8').slice(0, 50);
          combined += `\n\n=== FILE: ${d.storage_path} (unsupported type) ===\n${sample}`;
        }
        docCount += 1;
        if (combined.length >= LIMITS.perBid) break; // cap per-bid text
      }
      byBidText[b.id] = combined;
    }

    const totalExtractedChars = Object.values(byBidText).reduce((n, s) => n + (s?.length || 0), 0);
    if (totalExtractedChars === 0) {
      return new Response(JSON.stringify({ error: "No readable content extracted from documents. Ensure files are PDF/CSV/XLS/XLSX and not password-protected or scanned-only images." }), { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return new Response(JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY" }), { status: 500 });
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Build prompt with per-contractor snippets
    const promptPayload = bidList.slice(0, LIMITS.maxContractors).map(b => ({
      bid_id: b.id,
      contractor_name: b.contractor_id ? (contractors[b.contractor_id] || 'Contractor') : 'Contractor',
      documents_text: (byBidText[b.id] || '').slice(0, 600_000)
    }));

    const system = `You are a seasoned Construction Executive performing bid leveling for a single CSI division (or a sub-division).
You will be given, per contractor:
- One or more PDF bids provided as base64 (marked with PDF_BASE64) — treat these as the contractor's bid documents.
- For Excel (XLS/XLSX), all sheets are provided as CSV blocks with clear sheet names.
- For CSV and plain text, the raw text is provided.
Your tasks:
- Build a comprehensive list of scope items from all bids' content.
- For each contractor, mark each scope item as included, excluded, or not_specified; include priced amounts when present.
- Summarize qualifications: includes, excludes, allowances, alternates, payment terms, and any pertinent fine print.
- Provide a brief recommendation (selected contractor, rationale, next steps).
Output strict JSON only.`;

    const userMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `Division: ${division || ''}${subdivisionId ? `\nSubdivision: ${subdivisionId}` : ''}\n\nBids (per contractor):\n${promptPayload.map(p => `\n--- Contractor: ${p.contractor_name} (bid ${p.bid_id}) ---\n${p.documents_text}`).join('\n').slice(0, 450_000)}\n\nNotes:\n- PDF content is base64-encoded and may be truncated. Use visible text from CSV/XLSX blocks to corroborate where possible. If base64 cannot be read fully, infer from other files/sections.\n\nDesired JSON format (strict):\n${JSON.stringify({
        division_code: division || null,
        subdivision_id: subdivisionId || null,
        contractors: [{ contractor_id: '...', name: '...', total: 0 }],
        scope_items: ['...'],
        matrix: { '<scope>': { '<contractor_id>': { status: 'included', price: 0 } } },
        qualifications: { '<contractor_id>': { includes: [], excludes: [], allowances: [], alternates: [], payment_terms: [], fine_print: [] } },
        recommendation: { selected_contractor_id: '...', rationale: '...', next_steps: '...' }
      }, null, 2)}` }]
    };

    const callClaudeWithRetry = async (tries = 3) => {
      let attempt = 0;
      while (attempt < tries) {
        try {
          return await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 3500, temperature: 0.2, system, messages: [userMsg] });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Retry on rate limits
          if (/429|rate_limit/i.test(msg) && attempt < tries - 1) {
            const delay = Math.min(8000, 1500 * Math.pow(2, attempt));
            await new Promise(r => setTimeout(r, delay));
            attempt += 1;
            continue;
          }
          throw e;
        }
      }
      throw new Error('Claude request failed after retries');
    };

    let resp;
    try {
      resp = await callClaudeWithRetry(3);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: `Claude request failed: ${msg}` }), { status: 502 });
    }
    const block = Array.isArray(resp.content)
      ? (resp.content.find((b: unknown) => {
          if (typeof b !== 'object' || b === null) return false;
          const r = b as Record<string, unknown>;
          return r['type'] === 'text' && typeof r['text'] === 'string';
        }) as { type: string; text?: string } | undefined)
      : undefined;
    const content = block?.text || '{}';
    let parsed: Report;
    try { parsed = JSON.parse(content) as Report; } catch {
      return new Response(JSON.stringify({ error: 'AI returned invalid JSON', preview: content.slice(0, 800) }), { status: 502 });
    }

    // Persist report
    const { data: user } = await supabase.auth.getUser();
    const userId = user.user?.id;
    const { error: insErr } = await supabase.from('bid_level_reports').insert({ user_id: userId, job_id: jobId, division_code: division || null, subdivision_id: subdivisionId || null, report: parsed });
    if (insErr) return new Response(JSON.stringify({ error: `Failed to store report: ${insErr.message}` }), { status: 500 });

    return new Response(JSON.stringify({ ok: true, scope_count: parsed.scope_items?.length || 0 }), { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Allow': 'POST, OPTIONS'
    }
  });
}

export async function GET() {
  return NextResponse.json({ ok: false, error: 'Use POST' }, { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
}
