import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { ContentBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { extractWithPython, type ExtractResult } from "@/lib/extractorClient";
import { DIV23_SCOPE, buildSynonymIndex, canonize } from "@/lib/scope/d23";

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
  const reverseNameToId: Record<string, string> = {};
  Object.entries(contractorsMap).forEach(([id, name]) => { if (name) reverseNameToId[name.toLowerCase()] = id; });
  const canonicalContractors = Array.from(new Set(bidList.map(b => b.contractor_id || 'unassigned')))
    .map(cid => ({ contractor_id: cid === 'unassigned' ? null : cid, name: contractorsMap[cid] || 'Contractor' }));

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
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const extracted: ExtractResult = await extractWithPython(ab, d.storage_path);
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
          const msg = (e as Error)?.message || String(e);
          if (/Missing PDF_EXTRACTOR_URL/i.test(msg)) {
            await supabase
              .from('processing_jobs')
              .update({ status: 'failed', error: 'PDF_EXTRACTOR_URL is not set. Configure the Python extractor endpoint in environment variables.', finished_at: new Date().toISOString() })
              .eq('id', job.id);
            return NextResponse.json({ error: 'PDF_EXTRACTOR_URL not set' }, { status: 500 });
          }
          if (/404/.test(msg)) {
            await supabase
              .from('processing_jobs')
              .update({ status: 'failed', error: 'Extractor 404: Ensure the URL points to the /extract route (we now append /extract automatically).', finished_at: new Date().toISOString() })
              .eq('id', job.id);
            return NextResponse.json({ error: 'Extractor 404' }, { status: 500 });
          }
          // Skip embedding error text into candidate scope
          continue;
        }
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        type XLSXLike = { read: (b: Buffer, o: { type: 'buffer' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_csv: (ws: unknown) => string } };
        const x = XLSX as unknown as XLSXLike;
        const wb = x.read(buf, { type: 'buffer' });
        for (const wsName of wb.SheetNames) {
          const ws = wb.Sheets[wsName];
          const csv = x.utils.sheet_to_csv(ws);
          entry.texts.push({ name: `${d.storage_path} :: ${wsName}`, text: String(csv).slice(0, LIMITS.csvPerSheet) });
          if (entry.texts.length >= 8) break;
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
  const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  const scopeIndex = buildSynonymIndex(DIV23_SCOPE);

  // Build candidate scope items deterministically from extracted texts/tables
  const normalizeScope = (s: string) => {
    const t = s.replace(/[_\-\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const lower = t.toLowerCase();
    const skip = ['total', 'subtotal', 'tax', 'notes', 'note', 'bid form', 'signature', 'thank you', 'proposal', 'drawings', 'architectural drawings', 'mep drawings', 'specifications', 'schedule', 'pricing', 'valid for', 'lead times', 'receipt of order', 'warranty', 'contact', 'phone', 'email', 'address'];
    if (skip.includes(lower)) return '';
    return t.length > 120 ? t.slice(0, 120) : t;
  };

  const domainKeep = (line: string) => {
    const l = line.toLowerCase();
    if (!/[a-z]/.test(l)) return false;
    const exclude = /(proposal|letterhead|address|phone|email|fax|license|terms|valid\s*for|covid|thank you|signature|receipt|drawings|architectural|mep|specifications|schedule\b|pricing\b|bid form|submittal log)/i;
    if (exclude.test(l)) return false;
    const include = /(hvac|vrf|vrv|air handler|ahu|fan coil|ton\b|cfm\b|mbh\b|duct|grille|diffuser|register|damper|exhaust|filter|insulation|refrigerant|condensate|controls|bms|bacnet|ddc|tab\b|testing|balancing|startup|commission|crane|rigging|bim|shop drawings|title 24|seismic|permit|inspection|controller|selector box|split system|vav|terminal unit)/i;
    const moneyOrQty = /(\$\s?\d|\d+\s?(ea|each|qty|pcs?)\b)/i;
    return include.test(l) || moneyOrQty.test(l);
  };

  const detectSection = (line: string): string | null => {
    const l = line.toLowerCase().trim();
    if (/\b(scope\s*of\s*work|scope)\b/.test(l)) return 'scope';
    if (/\binclusions?\b/.test(l)) return 'inclusions';
    if (/\bexclusions?\b/.test(l)) return 'exclusions';
    if (/\ballowances?\b/.test(l)) return 'allowances';
    if (/\balternates?\b/.test(l)) return 'alternates';
    if (/(equipment\s*(list|schedule)|bill\s*of\s*materials|schedule\s*of\s*values)/.test(l)) return 'equipment';
    if (/services|commissioning|testing\s*&?\s*balancing/.test(l)) return 'services';
    return null;
  };
  const extractCandidatesFromText = (name: string, text: string): string[] => {
    const out: string[] = [];
    // If it looks like a table CSV, take first column as scope candidates
    if (/table/i.test(name) || text.includes(',')) {
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const first = (line.split(',')[0] || '').trim();
        if (!domainKeep(first)) continue;
        const n = normalizeScope(first);
        if (n && /[a-zA-Z]/.test(n) && n.length >= 2) out.push(n);
      }
    } else {
      // Bullet/section headers
      const lines = text.split(/\r?\n/);
      let section: string | null = null;
      for (const line of lines) {
        const sec = detectSection(line);
        if (sec) { section = sec; continue; }
        const m = line.match(/^\s*(?:[-*•\u2022]|\d+\.|[A-Z][\w\s]{2,})\s*(.+)$/);
        const candRaw = m ? m[1] : line;
        if (!(section && domainKeep(candRaw))) continue; // only from recognized sections
        const n = normalizeScope(candRaw);
        if (n && /[a-zA-Z]/.test(n) && n.length >= 3) out.push(n);
      }
    }
    return out;
  };
  const candidateUnionSet = new Set<string>();
  for (const b of bidList) {
    const docs = byBidDocs[b.id] || { texts: [] };
    for (const t of docs.texts) extractCandidatesFromText(t.name, t.text).forEach(s => candidateUnionSet.add(s));
  }
  // Canonicalize against division dictionary and keep unique
  const canonicalCandidates: string[] = [];
  for (const s of candidateUnionSet) {
    const canon = canonize(scopeIndex, s) || s;
    if (!canonicalCandidates.includes(canon)) canonicalCandidates.push(canon);
  }
  const candidateUnion = canonicalCandidates.slice(0, 300);

  // Aggregator pass: ask model to propose unified candidate scope from all bids
  try {
    const aggContent: ContentBlockParam[] = [];
    const aggIntro: TextBlockParam = { type: 'text', text: `You will propose a unified list of scope items for Division ${division || ''}. ONLY output JSON: {"scope_items": string[]} using canonical HVAC terms. Use evidence below; ignore addresses/boilerplate. Do not include totals or qualifications.` };
    aggContent.push(aggIntro);
    let aggChars = 0;
    for (const b of bidList) {
      aggContent.push({ type: 'text', text: `--- Contractor bid ${b.id} ---` });
      const docs = byBidDocs[b.id] || { texts: [] };
      for (const t of docs.texts) {
        if (aggChars > 160_000) break;
        const slice = t.text.length > 3000 ? t.text.slice(0, 3000) : t.text;
        aggContent.push({ type: 'text', text: `EXTRACT: ${t.name}\n${slice}` });
        aggChars += slice.length;
      }
    }
    const aggSystem = `You are a construction estimator. From multiple bids, propose a clean unified list of HVAC scope items (15-80 items max). Use concise canonical names; ignore boilerplate.`;
    const aggResp = await anthropic.messages.create({ model: MODEL, max_tokens: 1200, temperature: 0.1, system: aggSystem, messages: [{ role: 'user', content: aggContent }] } as unknown as Parameters<typeof anthropic.messages.create>[0]);
    const aggMsg = aggResp as unknown as { content?: Array<{ type: string; text?: string }> };
    const aggText = (Array.isArray(aggMsg.content) ? (aggMsg.content.find((b: unknown) => (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')) as { type: string; text?: string } | undefined)?.text || '' : '') as string;
    const aggParsed = (() => { try { return JSON.parse(aggText) as { scope_items?: string[] }; } catch { try { return JSON.parse((aggText.match(/\{[\s\S]*\}/)?.[0] || '{}')) as { scope_items?: string[] }; } catch { return { scope_items: [] }; } } })();
    const proposed = Array.isArray(aggParsed.scope_items) ? aggParsed.scope_items : [];
    for (const s of proposed) {
      const canon = canonize(scopeIndex, s) || s;
      if (!canonicalCandidates.includes(canon)) canonicalCandidates.push(canon);
    }
  } catch {}
  const candidateUnionFinal = canonicalCandidates.slice(0, 300);

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

  // Removed old normalization and merge helpers (not used in new two-pass pipeline)

  // (mergeReports no longer needed)

  type Qual = { includes?: string[]; excludes?: string[]; allowances?: string[]; alternates?: string[]; payment_terms?: string[]; fine_print?: string[] };
  type PerItem = { name: string; status: 'included'|'excluded'|'not_specified'; price?: number|null; notes?: string };
  type Unmapped = { name: string; evidence: string; confidence?: number };
  type PerContractor = { items: Array<PerItem>; qualifications?: Qual; unmapped?: Unmapped[] };
  const per: Record<string, PerContractor> = {};
  const unmappedPer: Record<string, Unmapped[]> = {};
  let done = 0;
  for (const batch of batches) {
    // batchSize=1 → single contractor per loop
    const b = batch[0];
    let content: ContentBlockParam[] = [];
    const contractorName = b.contractor_id ? (contractorsMap[b.contractor_id] || 'Contractor') : 'Contractor';
    const instruct: TextBlockParam = { type: 'text', text: `You are labeling scope coverage for a single contractor's bid. STRICT JSON ONLY.\nSCHEMA:{"items":[{"name":string,"status":"included"|"excluded"|"not_specified","price"?:number|null,"evidence":string}],"qualifications":{"includes"?:string[],"excludes"?:string[],"allowances"?:string[],"alternates"?:string[],"payment_terms"?:string[],"fine_print"?:string[]},"total"?:number|null,"unmapped":[{"name":string,"evidence":string,"confidence"?:number}]}\nRules:\n- ONLY choose item names that are EXACTLY present in CANDIDATE_SCOPE (case-insensitive). Do not invent new names.\n- If you find relevant scope not in the list, put it in 'unmapped' with a short evidence snippet and confidence 0..1; do not add it to 'items'.\n- Map differing wording to the closest candidate item (e.g., '40 ton AHU' → 'HVAC equipment' or 'VRF/VRV system' depending on context).\n- For each 'items' entry, include a brief evidence snippet (table row or nearby sentence with quantities/capacities/$).\n- Extract total/base bid if present; do not hallucinate prices.` };
    content.push(instruct);
    const candBlock: TextBlockParam = { type: 'text', text: `CANDIDATE_SCOPE (unified across all bids):\n${candidateUnionFinal.map((s,i)=>`${i+1}. ${s}`).join('\n')}` };
    content.push(candBlock);
    content.push({ type: 'text', text: `--- Contractor: ${contractorName} (id ${b.contractor_id || 'unassigned'}) ---` });
    const docs = byBidDocs[b.id] || { texts: [] };
    // Limit evidence to ~30k tokens worth of chars
    let accChars = 0;
    for (const c of docs.texts) {
      if (accChars > 120_000) break; // ~30k tokens
      // Drop boilerplate noise; keep likely line-items
      const lines = c.text.split(/\r?\n/);
      let section: string | null = null;
      const kept: string[] = [];
      for (const line of lines) {
        const sec = detectSection(line);
        if (sec) { section = sec; kept.push(`-- SECTION: ${sec.toUpperCase()}`); continue; }
        if (section && domainKeep(line)) kept.push(line);
      }
      const filtered = kept.join('\n');
      const snippet = filtered.length > 4000 ? filtered.slice(0, 4000) : filtered;
      const t: TextBlockParam = { type: 'text', text: `=== EXTRACT: ${c.name} ===\n${snippet}` };
      content.push(t);
      accChars += t.text.length;
    }

    // Token budget: approx tokens ~= chars/4. Trim content to stay below ~30k input tokens.
    const estTokens = (blocks: ContentBlockParam[]) => {
      let chars = 0;
      for (const b of blocks) {
        if (b.type === 'text') chars += (b.text || '').length;
      }
      return Math.ceil(chars / 4);
    };
    const trimToBudget = (blocks: ContentBlockParam[], maxTokens: number) => {
      let toks = estTokens(blocks);
      if (toks <= maxTokens) return blocks;
      // Trim large text blocks (prefer extracted tables/text first)
      if (toks > maxTokens) {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (toks <= maxTokens) break;
          if (b.type === 'text') {
            const textLen = (b.text || '').length;
            if ((b.text || '').includes('=== EXTRACT:') || textLen > 5000) {
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
    const system = `You are a construction estimator building a Division-level bid leveling matrix. Ignore letterheads, addresses, and proposal boilerplate. Focus on Scope of Work, Inclusions/Exclusions/Alternates/Allowances, equipment lists and SOV tables. Strict JSON only.`;

    const callClaudeWithRetry = async (tries = 4) => {
      let attempt = 0;
      while (attempt < tries) {
        try {
          return await anthropic.messages.create({ model: MODEL, max_tokens: 2800, temperature: 0.2, system, messages: [{ role: 'user', content }] } as unknown as Parameters<typeof anthropic.messages.create>[0]);
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
    const msg = resp as unknown as { content?: Array<{ type: string; text?: string }> };
    const block = Array.isArray(msg.content) ? (msg.content.find((b: unknown) => (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')) as { type: string; text?: string } | undefined) : undefined;
    const text = block?.text || '{}';
    const tryParse = (t: string) => { try { return JSON.parse(t) as { items?: PerItem[]; qualifications?: Qual; total?: number|null; unmapped?: Unmapped[] }; } catch { return null; } };
    const parsed = tryParse(text) || tryParse((text.match(/\{[\s\S]*\}/)?.[0] || '')) || { items: [], qualifications: {}, total: null, unmapped: [] } as { items?: PerItem[]; qualifications?: Qual; total?: number|null; unmapped?: Unmapped[] };
    const items = Array.isArray(parsed.items) ? parsed.items.filter(x => typeof x?.name === 'string' && typeof x?.status === 'string') : [];
    // Canonicalize item names to dictionary
    for (const it of items) {
      const mapped = canonize(scopeIndex, it.name);
      if (mapped) it.name = mapped;
    }
    // Enforce candidate_scope only; move others to unmapped
    const candidateSet = new Set(candidateUnionFinal.map(s => normalizeScope(s)));
    const kept: PerItem[] = [];
    const dropped: Unmapped[] = [];
    for (const it of items) {
      const ev = (typeof (it as unknown as { evidence?: string }).evidence === 'string') ? (it as unknown as { evidence?: string }).evidence as string : '';
      if (candidateSet.has(normalizeScope(it.name))) kept.push(it); else dropped.push({ name: it.name, evidence: ev });
    }
    const cidKey = b.contractor_id || 'unassigned';
    per[cidKey] = { items: kept, qualifications: parsed.qualifications, unmapped: parsed.unmapped };
    unmappedPer[cidKey] = [...(parsed.unmapped || []), ...dropped];
    done += 1;
    await supabase.from('processing_jobs').update({ batches_done: done, progress: Math.min(90, Math.round((done / batches.length) * 85) + 5) }).eq('id', job.id);
    // dynamic inter-batch delay based on input size to respect 40k tokens/min
    const usedTokens = (content as ContentBlockParam[]).reduce((acc, cb) => acc + (cb.type === 'text' ? ((cb as TextBlockParam).text?.length || 0) : 0), 0) / 4;
    const minDelayMs = Math.ceil((usedTokens / 40_000) * 60_000); // scale to minute window
    await new Promise(r => setTimeout(r, Math.max(1500, Math.min(20_000, minDelayMs))));
  }

  // Merge pass → final division-level report
  const scopeSet = new Set<string>(candidateUnion);
  Object.values(per).forEach(p => (p.items || []).forEach(it => { const n = normalizeScope(it.name || ''); if (n) scopeSet.add(n); }));
  const scopeItems = Array.from(scopeSet);
  const matrix: NonNullable<Report['matrix']> = {};
  for (const s of scopeItems) {
    matrix[s] = {};
    for (const b of bidList) {
      const cid = b.contractor_id || 'unassigned';
      const arr = per[cid]?.items || [];
      const found = arr.find((it: { name: string; status?: 'included'|'excluded'|'not_specified'; price?: number|null }) => normalizeScope(it.name) === s);
      matrix[s][cid] = { status: (found?.status || 'not_specified'), price: typeof found?.price === 'number' ? found?.price : null };
    }
  }
  const quals: NonNullable<Report['qualifications']> = {};
  for (const b of bidList) {
    const cid = b.contractor_id || 'unassigned';
    const q = (per[cid]?.qualifications || {}) as Record<string, unknown>;
    quals[cid] = {
      includes: Array.isArray(q?.includes) ? q?.includes : [],
      excludes: Array.isArray(q?.excludes) ? q?.excludes : [],
      allowances: Array.isArray(q?.allowances) ? q?.allowances : [],
      alternates: Array.isArray(q?.alternates) ? q?.alternates : [],
      payment_terms: Array.isArray(q?.payment_terms) ? q?.payment_terms : [],
      fine_print: Array.isArray(q?.fine_print) ? q?.fine_print : [],
    };
  }
  // Derive contractor totals if present or sum of included prices
  const contractorsWithTotals = canonicalContractors.map(c => {
    const cid = c.contractor_id || 'unassigned';
    let total: number | null = null;
    const items = per[cid]?.items || [];
    // try explicit total parsed by the model
    // @ts-expect-error: total may be provided in qualifications as note later; otherwise compute sum
    if (typeof (per[cid]?.total) === 'number') total = per[cid]?.total as unknown as number;
    if (total == null) {
      const sum = items.reduce((acc, it) => acc + ((it.status === 'included' && typeof it.price === 'number') ? it.price : 0), 0);
      total = sum > 0 ? sum : null;
    }
    return { ...c, total };
  });

  const mergedReport: Report & { unmapped?: Record<string, Unmapped[]> } = {
    division_code: division || null,
    subdivision_id: subdivisionId || null,
    contractors: contractorsWithTotals,
    scope_items: scopeItems,
    matrix,
    qualifications: quals,
    unmapped: unmappedPer,
  };

  const { data: user } = await supabase.auth.getUser();
  const userId = user.user?.id;
  await supabase.from('bid_level_reports').insert({ user_id: userId, job_id: job.job_id, division_code: division || null, subdivision_id: subdivisionId || null, report: mergedReport });
  await supabase.from('processing_jobs').update({ status: 'success', progress: 100, finished_at: new Date().toISOString() }).eq('id', job.id);
  return NextResponse.json({ ok: true, processed: job.id });
}
