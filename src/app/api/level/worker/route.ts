import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { ContentBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { extractWithPython, type ExtractResult } from "@/lib/extractorClient";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

// NOTE: This is a simple on-demand worker endpoint; in production use a scheduled/background worker.
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { global: { headers: { Authorization: auth } } });

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const XLSX = await import("xlsx");

  const LIMITS = {
    pdfB64PerFile: 120_000, // tighten per-file to help stay under 40k input tokens/min
    csvPerSheet: 50_000,
    perBid: 300_000,
    maxContractors: 5,
    batchSize: 1,
    maxDocsPerBid: 4
  } as const;

  const takeQueued = async () => {
    const { data } = await supabase
      .from('processing_jobs')
      .select('id,user_id,job_id,meta,status')
      .eq('status','queued')
      .order('created_at',{ ascending: true })
      .limit(1)
      .maybeSingle();
    return data as { id: string; user_id: string; job_id: string; meta: Record<string, unknown> | null; status: string } | null;
  };

  const job = await takeQueued();
  if (!job) return NextResponse.json({ ok: true, message: 'No queued jobs' });
  await supabase.from('processing_jobs').update({ status: 'running', started_at: new Date().toISOString(), progress: 5 }).eq('id', job.id);

  const meta = (job.meta ?? {}) as Record<string, unknown>;
  const division: string | null = typeof meta["division"] === 'string' ? (meta["division"] as string) : null;
  const subdivisionId: string | null = typeof meta["subdivisionId"] === 'string' ? (meta["subdivisionId"] as string) : null;

  let bidsQuery = supabase
    .from('bids')
    .select('id, user_id, contractor_id, job_id, division_code, subdivision_id')
    .eq('job_id', job.job_id);
  if (subdivisionId) bidsQuery = bidsQuery.eq('subdivision_id', subdivisionId);
  else bidsQuery = bidsQuery.eq('division_code', division || null).is('subdivision_id', null);
  const { data: bids, error: bidsErr } = await bidsQuery;
  if (bidsErr) {
    await supabase.from('processing_jobs').update({ status: 'failed', error: bidsErr.message, finished_at: new Date().toISOString() }).eq('id', job.id);
    return NextResponse.json({ error: bidsErr.message }, { status: 500 });
  }
  const bidList = (bids || []).slice(0, LIMITS.maxContractors);
  if (!bidList.length) {
    await supabase.from('processing_jobs').update({ status: 'failed', error: 'No bids found', finished_at: new Date().toISOString() }).eq('id', job.id);
    return NextResponse.json({ error: 'No bids' }, { status: 400 });
  }

  const contractorIds = Array.from(new Set(bidList.map(b => b.contractor_id).filter(Boolean))) as string[];
  const contractorsMap: Record<string, string> = {};
  if (contractorIds.length) {
    const { data: cons } = await supabase.from('contractors').select('id,name').in('id', contractorIds);
    (cons || []).forEach(c => { contractorsMap[c.id] = c.name; });
  }

  const byBidDocs: Record<string, { texts: { name: string; text: string }[] }> = {};
  for (const b of bidList) {
    const { data: docs, error: docsErr } = await supabase.from('documents').select('storage_path').eq('bid_id', b.id);
    if (docsErr) continue;
    const entry = { texts: [] as { name: string; text: string }[] };
    let docCount = 0;
    for (const d of (docs || [])) {
      if (docCount >= LIMITS.maxDocsPerBid) break;
      const { data: blob } = await supabase.storage.from('bids').download(d.storage_path);
      if (!blob) continue;
      const buf = Buffer.from(await blob.arrayBuffer());
      const lower = d.storage_path.toLowerCase();
      if (lower.endsWith('.pdf')) {
        try {
          const extracted: ExtractResult = await extractWithPython(buf, d.storage_path);
          for (const p of extracted.pages) {
            if (p.tables && p.tables.length) {
              p.tables.forEach((tbl, ti) => {
                const csv = tbl.map(row => row.map(c => (c ?? '').replace(/\n/g,' ')).join(',')).join('\n');
                entry.texts.push({ name: `${d.storage_path} :: page ${p.number} :: table ${ti+1}`, text: csv });
              });
            }
            if (p.text_blocks && p.text_blocks.length) {
              const block = p.text_blocks.join('\n');
              entry.texts.push({ name: `${d.storage_path} :: page ${p.number} :: text`, text: block });
            }
          }
        } catch (e) {
          // fallback: raw bytes size note
          entry.texts.push({ name: `${d.storage_path} :: pdf`, text: `PDF extraction failed: ${(e as Error).message}` });
        }
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        type XLSXLike = { read: (b: Buffer, o: { type: 'buffer' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_csv: (ws: unknown) => string } };
        const x = XLSX as unknown as XLSXLike;
        const wb = x.read(buf, { type: 'buffer' });
        for (const wsName of wb.SheetNames) {
          const ws = wb.Sheets[wsName];
          const csv = x.utils.sheet_to_csv(ws);
          entry.texts.push({ name: `${d.storage_path} :: ${wsName}`, text: String(csv).slice(0, LIMITS.csvPerSheet) });
          if (entry.csvBlocks.length >= 8) break;
        }
      } else if (lower.endsWith('.csv')) {
        entry.texts.push({ name: d.storage_path, text: buf.toString('utf8').slice(0, LIMITS.csvPerSheet) });
      }
      docCount += 1;
    }
    byBidDocs[b.id] = entry;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    await supabase.from('processing_jobs').update({ status: 'failed', error: 'Missing ANTHROPIC_API_KEY', finished_at: new Date().toISOString() }).eq('id', job.id);
    return NextResponse.json({ error: 'Missing ANTHROPIC_API_KEY' }, { status: 500 });
  }
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const batches: typeof bidList[] = [];
  for (let i = 0; i < bidList.length; i += LIMITS.batchSize) batches.push(bidList.slice(i, i + LIMITS.batchSize));
  await supabase.from('processing_jobs').update({ batches_total: batches.length }).eq('id', job.id);

  type Report = {
    division_code: string | null;
    subdivision_id?: string | null;
    contractors?: Array<{ contractor_id: string | null; name: string; total?: number | null }>;
    scope_items?: string[];
    matrix?: Record<string, Record<string, { status: string; price?: number | null }>>;
    qualifications?: Record<string, { includes?: string[]; excludes?: string[]; allowances?: string[]; alternates?: string[]; payment_terms?: string[]; fine_print?: string[] }>;
    recommendation?: unknown;
  };

  const mergeReports = (acc: Report, cur: Report): Report => {
    const out: Report = acc.contractors ? { ...acc } : { division_code: division || null, subdivision_id: subdivisionId || null, contractors: [], scope_items: [], matrix: {}, qualifications: {} };
    const contractors = (cur.contractors || []);
    for (const c of contractors) {
      if (!out.contractors!.some(x => (x.contractor_id || 'unassigned') === (c.contractor_id || 'unassigned'))) out.contractors!.push(c);
    }
    const scope = (cur.scope_items || []);
    for (const s of scope) if (!out.scope_items!.includes(s)) out.scope_items!.push(s);
    const m = cur.matrix || {};
    for (const s of Object.keys(m)) {
      out.matrix![s] = out.matrix![s] || {};
      for (const cid of Object.keys(m[s]!)) out.matrix![s]![cid] = m[s]![cid];
    }
    const q = cur.qualifications || {};
    for (const cid of Object.keys(q)) {
      const t = out.qualifications![cid] || { includes: [], excludes: [], allowances: [], alternates: [], payment_terms: [], fine_print: [] };
      const add = (k: keyof typeof t) => {
        const src = q[cid] as Record<string, unknown> | undefined;
        const vals = (src?.[k] as string[] | undefined);
        if (Array.isArray(vals)) t[k] = Array.from(new Set([...(t[k] || []), ...vals]));
      };
      add('includes'); add('excludes'); add('allowances'); add('alternates'); add('payment_terms'); add('fine_print');
      out.qualifications![cid] = t;
    }
    return out;
  };

  let merged: Report | null = null;
  let done = 0;
  for (const batch of batches) {
    let content: ContentBlockParam[] = [];
    for (const b of batch) {
      const contractorName = b.contractor_id ? (contractorsMap[b.contractor_id] || 'Contractor') : 'Contractor';
      const txt: TextBlockParam = { type: 'text', text: `--- Contractor: ${contractorName} (bid ${b.id}) ---` };
      content.push(txt);
      const docs = byBidDocs[b.id] || { texts: [] };
      for (const c of docs.texts) {
        const t: TextBlockParam = { type: 'text', text: `=== EXTRACT: ${c.name} ===\n${c.text}` };
        content.push(t);
      }
    }

    // Token budget: approx tokens ~= chars/4. Trim content to stay below ~30k input tokens.
    const estTokens = (blocks: ContentBlockParam[]) => {
      let chars = 0;
      for (const b of blocks) {
        if (b.type === 'text') chars += (b.text || '').length;
        if (b.type === 'document' && (b as DocumentBlockParam).source?.type === 'base64') {
          const src = (b as DocumentBlockParam).source as Base64PDFSource;
          chars += (src.data || '').length;
        }
      }
      return Math.ceil(chars / 4);
    };
    const trimToBudget = (blocks: ContentBlockParam[], maxTokens: number) => {
      let toks = estTokens(blocks);
      if (toks <= maxTokens) return blocks;
      // Prefer trimming PDF data first, largest first
      const docsIdx: number[] = [];
      blocks.forEach((b, i) => { if (b.type === 'document') docsIdx.push(i); });
      // sort by size desc
      docsIdx.sort((a, b) => {
        const da = ((blocks[a] as DocumentBlockParam).source as Base64PDFSource).data?.length || 0;
        const db = ((blocks[b] as DocumentBlockParam).source as Base64PDFSource).data?.length || 0;
        return db - da;
      });
      for (const i of docsIdx) {
        if (toks <= maxTokens) break;
        const src = ((blocks[i] as DocumentBlockParam).source as Base64PDFSource);
        const cur = src.data || '';
        if (cur.length > 40_000) { // keep minimum data
          src.data = cur.slice(0, Math.max(40_000, Math.floor(cur.length * 0.6)));
          toks = estTokens(blocks);
        }
      }
      // If still over, trim CSV text blocks
      if (toks > maxTokens) {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (toks <= maxTokens) break;
          if (b.type === 'text') {
            const textLen = (b.text || '').length;
            if ((b.text || '').includes('=== SHEET/TEXT:') || textLen > 5000) {
            const t = b.text || '';
            (b as TextBlockParam).text = t.slice(0, Math.max(2000, Math.floor(t.length * 0.6)));
            toks = estTokens(blocks);
            }
          }
        }
      }
      return blocks;
    };

    content = trimToBudget(content, 30_000);
    const system = `You are a seasoned Construction Executive performing bid leveling for a single CSI division (or a sub-division).
Build a comprehensive list of scope items. For each contractor, mark each scope item as included, excluded, or not_specified; include priced amounts when present.
Summarize qualifications: includes, excludes, allowances, alternates, payment terms, fine print. Provide a brief recommendation. Output strict JSON only.`;

    const callClaudeWithRetry = async (tries = 4) => {
      let attempt = 0;
      while (attempt < tries) {
        try {
          return await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 2800, temperature: 0.2, system, messages: [{ role: 'user', content }] });
        } catch (e) {
          const msg = (e as Error).message || '';
          // backoff on rate limit
          if (/429|rate_limit/i.test(msg) && attempt < tries - 1) {
            const delay = Math.min(15000, 3000 * Math.pow(2, attempt));
            await new Promise(r => setTimeout(r, delay + Math.floor(Math.random()*500)));
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
      resp = await callClaudeWithRetry();
    } catch (e) {
      await supabase.from('processing_jobs').update({ status: 'failed', error: (e as Error).message, finished_at: new Date().toISOString() }).eq('id', job.id);
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
    const block = Array.isArray(resp.content) ? (resp.content.find((b: unknown) => (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')) as { type: string; text?: string } | undefined) : undefined;
    const text = block?.text || '{}';
    let parsed: Report = { division_code: division || null };
    try { parsed = JSON.parse(text) as Report; } catch {}
    merged = merged ? mergeReports(merged, parsed) : parsed;
    done += 1;
    await supabase.from('processing_jobs').update({ batches_done: done, progress: Math.min(95, Math.round((done / batches.length) * 90) + 5) }).eq('id', job.id);
    // dynamic inter-batch delay based on input size to respect 40k tokens/min
    const usedTokens = (content as ContentBlockParam[]).reduce((acc, b) => {
      if (b.type === 'text') return acc + ((b as TextBlockParam).text?.length || 0);
      if (b.type === 'document') {
        const s = (b as DocumentBlockParam).source;
        if (s && (s as Base64PDFSource).type === 'base64') return acc + (((s as Base64PDFSource).data || '').length);
      }
      return acc;
    }, 0) / 4;
    const minDelayMs = Math.ceil((usedTokens / 40_000) * 60_000); // scale to minute window
    await new Promise(r => setTimeout(r, Math.max(1500, Math.min(20_000, minDelayMs))));
  }

  if (!merged) {
    await supabase.from('processing_jobs').update({ status: 'failed', error: 'No merged report', finished_at: new Date().toISOString() }).eq('id', job.id);
    return NextResponse.json({ error: 'No merged report' }, { status: 500 });
  }

  const { data: user } = await supabase.auth.getUser();
  const userId = user.user?.id;
  await supabase.from('bid_level_reports').insert({ user_id: userId, job_id: job.job_id, division_code: division || null, subdivision_id: subdivisionId || null, report: merged });
  await supabase.from('processing_jobs').update({ status: 'success', progress: 100, finished_at: new Date().toISOString() }).eq('id', job.id);
  return NextResponse.json({ ok: true, processed: job.id });
}
