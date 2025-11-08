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
  try { console.log('[version]', process.env.VERCEL_GIT_COMMIT_SHA || 'local'); } catch {}

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
  const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
  const scopeIndex = buildSynonymIndex(DIV23_SCOPE);

  // Debug: log configuration
  try { console.log(`[Config] MODEL=${MODEL}, SIMPLIFIED_MODE=true`); } catch {}

  // Utilities to parse totals from evidence text
  const parseMoney = (s: string): number | null => {
    const cleaned = s.replace(/[,\s]/g, '');
    const m = cleaned.match(/\$?(\d+(?:\.\d{2})?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const findTotalInText = (text: string): number | null => {
    // Primary: common phrasings across divisions
    const re = /(total\s*(?:base\s*)?(?:bid|price|amount)|base\s*(?:bid|price)\s*(?:total)?|bid\s*(?:amount|price)|proposal\s*(?:total|amount|price)|contract\s*amount)\s*[:\-]?\s*\$?\s*([0-9][\d,]*(?:\.\d{2})?)/gi;
    let best: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const val = parseMoney(m[2] || '');
      if (val != null) best = val; // keep last seen
    }
    if (best != null) return best;
    // Fallback: look for a line containing a keyword and capture the nearest $ amount within 100 chars
    const kw = /(base\s*bid|base\s*price|total\s*bid|total\s*price|bid\s*amount|proposal\s*(?:total|amount|price))/i;
    const lines = text.split(/\r?\n/);
    for (const ln of lines) {
      if (kw.test(ln)) {
        const m2 = ln.match(/\$\s*([0-9][\d,]*(?:\.\d{2})?)/);
        if (m2) {
          const val = parseMoney(m2[1] || '');
          if (val != null) return val;
        }
      }
    }
    return null;
  };

  // Utility: identify totals-like strings that should never become scope items
  const isTotalsLike = (s: string) => /(base\s*(?:bid|price)|total(?:\s*(?:price|amount))?|bid\s*amount|proposal\s*(?:total|amount)|subtotal|sales\s*tax)/i.test(s);
  const cleanEvidence = (t: string) => t
    // avoid truncation around colon-dollar patterns
    .replace(/:\s*\$(?=\s*\d)/g, ' $')
    .replace(/\bis:\s*\$/gi, ' is $');

  // Strip number/letter prefixes from scope items
  const stripPrefix = (s: string): string => {
    // Remove patterns like: "1. ", "a. ", "b. ", "i. ", "2. Install", etc.
    return s
      .replace(/^[a-z]\.\s*/i, '') // "a. something" → "something"
      .replace(/^\d+\.\s*/, '') // "1. something" → "something"
      .replace(/^[ivxIVX]+\.\s*/, '') // "i. something" → "something"
      .replace(/^\([a-z0-9]+\)\s*/i, '') // "(a) something" → "something"
      .trim();
  };

  // Capitalize first letter for consistency
  const capitalizeFirst = (s: string): string => {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  // Normalize an alternate line to a clean scope row, dropping amounts and boilerplate
  const normalizeAlternateTitle = (s: string): string | null => {
    let t = s.trim();
    if (!t) return null;
    // Remove dollar amounts and bracketed deduct markers
    t = t.replace(/\$\s*<?\s*[0-9][\d,\s]*(?:\.\d{2})?\s*>?/g, ' ');
    // Remove leading common phrases
    t = t.replace(/^\s*(the\s+)?(add|deduct)\s+alternate\s*(to|for)?\s*/i, '')
         .replace(/^\s*alternate\s*:?\s*/i, '')
         .replace(/^\s*at\s*/i, '');
    // Remove leftover numbering/prefixes after phrase removal
    t = t.replace(/^\s*(?:\d+\.|[ivxIVX]+\.|\([a-z0-9]+\))\s*/, '');
    // Drop trailing 'is' / 'is:' and common phrasing like "the add alternate for/to"
    t = t.replace(/\bthe\s+add\s+alternate\s+(?:to|for)\s+/i, '');
    t = t.replace(/\bis\s*:?\s*$/i, '').trim();
    // Drop a leading standalone 'the '
    t = t.replace(/^\s*the\s+/i, '');
    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();
    // Skip non-descriptive alternates like just 'Unit'
    if (!t || /^unit\b/i.test(t)) return null;
    return `Alternate: ${capitalizeFirst(t)}`;
  };

  // Reduce overly long lines into generic, division-agnostic canonical forms
  const reduceGeneric = (s: string): string | null => {
    const l = s.toLowerCase().trim();
    if (!l) return null;
    // Filter boilerplate phrasing that sometimes slips through
    if (/^equipment\s+and\s+scope\s+of\s+work\b/.test(l)) return null;
    if (/^period\s+of\s+one\b/.test(l)) return null;
    // Canonicalize common scope phrases across divisions
    if (/^test(?:ing)?\s*(?:&|and)\s*balanc/i.test(l)) return 'Test and balance';
    return s;
  };

  // Detect and filter out non-scope junk - ULTRA CONSERVATIVE (only obvious header junk)
  const isJunkLine = (s: string): boolean => {
    const trimmed = s.trim();
    if (trimmed.length < 2) return true; // Empty or nearly empty

    // const l = trimmed.toLowerCase(); // not used

    // ONLY filter obvious letterhead/header junk that appears standalone
    // Company name ONLY if it's by itself on the line
    if (/^[a-z\s]+(mechanical|construction|engineering)\s*$/i.test(trimmed) && trimmed.length < 40) return true;

    // Street addresses ONLY if they're standalone (not part of a sentence)
    if (/^\d+\s+[a-z\s]+(ave|avenue|st|street|rd|road|blvd|dr|way|pl|ct)\b/i.test(trimmed) && trimmed.length < 50) return true;

    // City/state/zip ONLY if standalone
    if (/^[a-z\s]+,\s+(ca|california|ny|tx|fl)\s+\d{5}$/i.test(trimmed)) return true;

    // Standalone phone/fax lines (but NOT lines that contain phone + other content)
    if (/^(phone|fax|tel|office)?\s*:?\s*\(?\d{3}\)?[.\-\s]?\d{3}[.\-\s]?\d{4}\s*$/i.test(trimmed)) return true;

    // License lines (standalone only)
    if (/^(license|lic)\s*(number|no|#)?:?\s*\d+\s*$/i.test(trimmed)) return true;

    // Email addresses (standalone only)
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) return true;

    // Salutations (standalone only)
    if (/^(dear|attn:|attention:)\s+[a-z\s]+:?\s*$/i.test(trimmed) && trimmed.length < 50) return true;

    // Website URLs (standalone only)
    if (/^(www\.|https?:\/\/)[a-z0-9.-]+\.[a-z]{2,}\s*$/i.test(trimmed)) return true;

    return false;
  };

  // Build candidate scope items deterministically from extracted texts/tables
  const normalizeScope = (s: string) => {
    const t = s.replace(/[_\-\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (isJunkLine(t)) return '';
    const lower = t.toLowerCase();
    const skip = ['total', 'subtotal', 'tax', 'notes', 'note', 'bid form', 'signature', 'thank you', 'proposal', 'drawings', 'architectural drawings', 'mep drawings', 'specifications', 'schedule', 'pricing', 'valid for', 'lead times', 'receipt of order', 'warranty', 'contact', 'phone', 'email', 'address'];
    if (skip.includes(lower)) return '';
    return t.length > 120 ? t.slice(0, 120) : t;
  };

  // Normalize text for filtering regardless of bullets/punctuation
  const normFilter = (s: string) => s
    .toLowerCase()
    .replace(/[•\-*_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Explicit document-reference and narrative filters (division-agnostic, match anywhere)
  const isDocRefLine = (line: string) => {
    const l = normFilter(line);
    return /(bid documents|drawings|architectural drawings|mep drawings|plans|sheet\s*no\.|sheets?|project\s*name|specifications?|spec\s*section|division\s*\d+|addendum|rfi|submittals?|schedule|proposal(\s*#)?|page\s*\d+)/i.test(l);
  };
  const isNarrativeLine = (line: string) => {
    const l = normFilter(line);
    return /(thank you|we are assuming|we assume|assum(e|ptions)|shall|will\s+provide|please|sincerely|valid\s+for\s+\d+\s+days|warranty|lead\s*times?|due to|this proposal is based)/i.test(l);
  };
  // Additional boilerplate/business lines that should not become scope
  const isBoilerplateLine = (line: string) => {
    const l = normFilter(line);
    return /(reserves\s+the\s+right|lock\s*in\s+pricing|make\s+every\s+effort|adequate\s+access|break\s+area|laydown\s+space|workmanship|free\s+from\s+defects|system\s+in\s+its\s+entirety\s+is\s+properly\s+serviced|file\s+in\s+cad\s+format|navis|upload\s+per\s+week|ftp\s+site|parking\s+and\s+material\s+staging|equipment\s+storage|equipment\s+rentals?\s+as\s+required|provide\s+construction\s+services|permit\s+plan\s*check|traffic\s+control|close\s*out\s+documentation|clean[- ]?up|general\s+conditions|equipment\s+and\s+scope\s+of\s+work|period\s+of\s+one\s*\(\s*1\s*\)\s*year|warrant(?:y|ies)\s+will\s+be\s+as\s+stated)/i.test(l);
  };
  // Do NOT filter alternates from scope; keep them as rows so prices can appear in matrix
  const isAlternateLike = (_line: string) => false;

  const domainKeep = (line: string) => {
    const l = line.toLowerCase();
    if (!/[a-z]/.test(l)) return false;
    // First check if it's junk
    if (isJunkLine(line)) return false;
    const exclude = /(proposal|letterhead|address|phone|email|fax|license|terms|valid\s*for|covid|thank you|signature|receipt|submittal log|attn:|dear\s|re:|subject:|sincerely|warranty|page\s+\d+$)/i;
    if (exclude.test(l)) return false;

    // DIVISION-AGNOSTIC: Keep lines that indicate work scope
    // Use generic construction keywords that apply to ALL CSI divisions
    const scopeIndicators = /(install|furnish|provide|supply|demolish|remove|repair|replace|construct|build|fabricate|erect|place|pour|apply|coat|paint|finish|seal|waterproof|insulate|test|inspect|commission|balance|startup|certif|equipment|material|system|unit|assembly|component|schedule|quantity|specification)/i;
    const moneyOrQty = /(\$\s?\d|\d+\s?(ea|each|qty|pcs?|sf|lf|sy|cy|cf|ls|ton|gal|lb)\b)/i;

    // Keep if it has scope indicators OR money/quantity
    return scopeIndicators.test(l) || moneyOrQty.test(l);
  };

  const detectSection = (line: string): string | null => {
    const l = line.toLowerCase().trim();
    // More flexible section detection patterns
    if (/(\bscope\b|scope\s*of\s*work|^\s*sco?pe|general\s*(mechanical|hvac)\s*inclusions?|^\s*work\s*included?)/.test(l)) return 'scope';
    if (/(\binclusions?\b|^\s*inclu\w*|^\s*inclusio\w*|^\s*included?\b|what'?s?\s*included)/.test(l)) return 'inclusions';
    if (/(\bexclusions?\b|^\s*exclu\w*|^\s*excluded?\b|not\s*included|what'?s?\s*excluded)/.test(l)) return 'exclusions';
    if (/(\ballowances?\b|^\s*allowan\w*)/.test(l)) return 'allowances';
    // Treat only explicit 'alternate' headers as alternates; 'options' is too generic
    if (/(\balternates?\b|^\s*alternat\w*)/.test(l)) return 'alternates';
    if (/(equipment\s*(list|schedule)|bill\s*of\s*materials|schedule\s*of\s*values|materials\s*list)/.test(l)) return 'equipment';
    if (/(\bservices\b|commissioning|testing\s*&?\s*balancing|^\s*clarifications?\b|^\s*notes?\b)/.test(l)) return 'services';
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
        if (isDocRefLine(first) || isNarrativeLine(first) || isBoilerplateLine(first)) continue;
        // If an alternate-like row appears in a table, normalize and keep only the clean title
        const altLikeTbl = /(\b(add|deduct)\s+alternate\b|^alternate\b|\bunit\s+is\s*:|\bat\s+fc\b|\$\s*\d)/i.test(first);
        if (altLikeTbl) {
          const alt = normalizeAlternateTitle(first);
          if (alt) { out.push(alt); continue; }
        }
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
        // skip totals lines as scope candidates
        if (/(^|\b)(base\s*(?:bid|price)|total(?:\s*(?:price|amount))?|bid\s*amount|proposal\s*(?:total|amount))\b/i.test(candRaw)) continue;
        if (isDocRefLine(candRaw) || isNarrativeLine(candRaw) || isBoilerplateLine(candRaw)) continue;
        // Alternates anywhere: include normalized title and do not add raw
        const altLike = section === 'alternates' || /(\b(add|deduct)\s+alternate\b|^alternate\b|\bunit\s+is\s*:|\bat\s+fc\b|\$\s*\d)/i.test(candRaw);
        if (altLike) {
          const alt = normalizeAlternateTitle(candRaw);
          if (alt) out.push(alt);
          continue;
        }
        // Restrict to true scope-bearing sections only (plus alternates handled above)
        if (!(section && (section === 'scope' || section === 'inclusions' || section === 'equipment'))) continue;
        if (!domainKeep(candRaw)) continue;
        const n = normalizeScope(candRaw);
        if (n && /[a-zA-Z]/.test(n) && n.length >= 3) out.push(n);
      }
    }
    return out;
  };
  // Helper: detect parent headers that shouldn't be scope items
  const isParentHeader = (s: string): boolean => {
    return /(including the following|as follows|to include):\s*$/i.test(s);
  };

  const candidateUnionSet = new Set<string>();
  for (const b of bidList) {
    const docs = byBidDocs[b.id] || { texts: [] };
    for (const t of docs.texts) {
      extractCandidatesFromText(t.name, t.text).forEach(s => {
        // Strip prefixes BEFORE adding to set
        let stripped = stripPrefix(s);
        const reduced = reduceGeneric(stripped);
        if (reduced === null || reduced === '') return;
        stripped = reduced;
        // Skip parent headers
        if (!isParentHeader(stripped)) {
          candidateUnionSet.add(stripped);
        }
      });
    }
  }
  // Canonicalize against division dictionary and keep unique
  const canonicalCandidates: string[] = [];
  for (const s of candidateUnionSet) {
    const canon = canonize(scopeIndex, s) || s;
    if (!canonicalCandidates.includes(canon)) canonicalCandidates.push(canon);
  }
  let candidateUnion = canonicalCandidates.filter(s => !isTotalsLike(s));
  candidateUnion = candidateUnion.slice(0, 300);

  // Aggregator pass: ask model to propose unified candidate scope from all bids
  let aggList: string[] = [];
  try {
    const aggContent: ContentBlockParam[] = [];
    const divisionName = division ? `Division ${division}` : 'this construction project';
    const aggIntro: TextBlockParam = { type: 'text', text: `You will propose a unified, normalized list of scope items for ${divisionName}. ONLY output JSON: {"scope_items": string[]}.

CRITICAL RULES:
- Consolidate granular items into higher-level categories
- Use standard construction/trade terminology appropriate for this division
- Ignore and exclude: company names, addresses, phone numbers, email headers, document references (drawings/specs), narrative text, section headers, page numbers
- DO NOT include: contractor company names, street addresses, "Attn:", "Dear", phone numbers, "Drawings", "Specifications", "Proposal", "Page X", etc.
- Focus on actual work scope only: equipment, systems, services, materials, installation tasks
- OUTPUT STRICT NOUN PHRASES only (no sentences). Examples: "Ductwork", "VRF/VRV system", "Fire/smoke dampers".
- 20-40 items max (prefer fewer, well-normalized categories)
- Do not include totals, qualifications, exclusions, alternates, clarifications, or contract terms
- Remove number/letter prefixes from all items (e.g., "a.", "1.", "i.")` };
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
    const aggSystem = `You are a construction estimator normalizing scope across multiple contractor bids for ${divisionName}. Produce a clean, consolidated list of short noun-phrase scope categories. Ignore boilerplate, addresses, document references, clarifications, assumptions, warranty. Consolidate specifics into general categories. Remove all number/letter prefixes. Output 20-40 items.`;
    const aggResp = await anthropic.messages.create({ model: MODEL, max_tokens: 1200, temperature: 0.1, system: aggSystem, messages: [{ role: 'user', content: aggContent }] } as unknown as Parameters<typeof anthropic.messages.create>[0]);
    const aggMsg = aggResp as unknown as { content?: Array<{ type: string; text?: string }> };
    const aggText = (Array.isArray(aggMsg.content) ? (aggMsg.content.find((b: unknown) => (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')) as { type: string; text?: string } | undefined)?.text || '' : '') as string;
    const aggParsed = (() => { try { return JSON.parse(aggText) as { scope_items?: string[] }; } catch { try { return JSON.parse((aggText.match(/\{[\s\S]*\}/)?.[0] || '{}')) as { scope_items?: string[] }; } catch { return { scope_items: [] }; } } })();
    let proposed = Array.isArray(aggParsed.scope_items) ? aggParsed.scope_items : [];
    // Normalize alternates in the aggregator output only when clearly alternate-like
    proposed = proposed.map(s => {
      const hasAltSignal = /\balternat(e|es|e:)|\b(add|deduct)\s+alternate\b|\$\s*\d/i.test(s);
      if (hasAltSignal) {
        const alt = normalizeAlternateTitle(s);
        return alt || '';
      }
      return s;
    });
    for (const s of proposed) {
      const stripped = stripPrefix(s);
      // Skip parent headers
      if (isParentHeader(stripped)) continue;
      const canon = canonize(scopeIndex, stripped) || stripped;
      if (!canonicalCandidates.includes(canon)) canonicalCandidates.push(canon);
    }
    aggList = proposed.map(stripPrefix).filter(Boolean);
  } catch {}
  // Prefer aggregator output first, then add cleaned leftovers
  const prioritized = [...new Set([...(aggList || []).map(s => canonize(scopeIndex, s) || s), ...canonicalCandidates])];
  // Final aggressive filter: remove any junk that made it through
  // Finalize candidates with additional normalization + dedupe
  const finalizeCandidates = (arr: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let s of arr) {
      if (isTotalsLike(s) || isJunkLine(s) || isParentHeader(s) || isDocRefLine(s) || isNarrativeLine(s)) continue;
      if (s.length < 3 || s.length > 150) continue;
      // Generic reductions (e.g., long 'test and balance' sentences)
      const reduced = reduceGeneric(s);
      s = reduced ?? s;
      // Re-normalize alternates if any phrasing slipped through
      if (/\balternate\b/i.test(s)) {
        const altNorm = normalizeAlternateTitle(s);
        if (altNorm) s = altNorm; else continue; // drop bare 'Alternate' or non-descriptive lines
      }
      s = capitalizeFirst(s);
      const key = s.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(s); }
      if (out.length >= 100) break;
    }
    return out;
  };
  const candidateUnionFinal = finalizeCandidates(prioritized);

  // Log noise metrics
  try {
    const rawCount = candidateUnionSet.size;
    const finalCount = candidateUnionFinal.length;
    const noiseRatio = rawCount ? Number(((rawCount - finalCount) / rawCount).toFixed(2)) : 0;
    console.log('[Pass1] candidates_raw', rawCount, 'candidates_final', finalCount, 'noise_ratio', noiseRatio);
  } catch {}

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
  type PerContractor = { items: Array<PerItem>; qualifications?: Qual; unmapped?: Unmapped[]; total?: number | null };
  const per: Record<string, PerContractor> = {};
  const unmappedPer: Record<string, Unmapped[]> = {};

  // Build a map from canonical normalized scope name -> the candidate scope string we will display
  const candidateNormToDisplay = new Map<string,string>();
  for (const s of candidateUnionFinal) {
    const canon = canonize(scopeIndex, s) || s;
    const norm = normalizeScope(canon);
    if (norm) candidateNormToDisplay.set(norm, s);
  }
  const mapToCandidate = (name: string): string | null => {
    const canon = canonize(scopeIndex, name) || name;
    const norm = normalizeScope(canon);
    if (!norm) return null;
    return candidateNormToDisplay.get(norm) || null;
  };
  let done = 0;
  for (const batch of batches) {
    // batchSize=1 → single contractor per loop
    const b = batch[0];
    let content: ContentBlockParam[] = [];
    const contractorName = b.contractor_id ? (contractorsMap[b.contractor_id] || 'Contractor') : 'Contractor';
    const instruct: TextBlockParam = { type: 'text', text: `Analyze this contractor's bid documents and determine, for each row in CANDIDATE_SCOPE, whether it is included, excluded, or not_specified.

OUTPUT FORMAT (JSON only):
{
  "items": [
    {"candidate_index": number, "status": "included|excluded|not_specified", "price": number|null, "evidence": "short quote that proves this"}
  ],
  "qualifications": {
    "includes": ["items explicitly listed as included"],
    "excludes": ["items explicitly listed as excluded"],
    "allowances": ["allowance items"],
    "alternates": ["alternate options"]
  },
  "total": base_bid_total_or_null
}

REQUIREMENTS (division-agnostic):
- There are exactly ${candidateUnionFinal.length} rows in CANDIDATE_SCOPE. Output ONE item per row, in order, with candidate_index = 1..${candidateUnionFinal.length} and the status for that row. If you cannot find any mention, use not_specified.
- You may set price when a clear dollar amount is tied to that exact row; otherwise null.
- Evidence must be a small, verbatim fragment.
` };

STATUS RULES:
1) included = clear mention of furnishing/providing/installing or present in scope/equipment/SOV.
2) excluded = appears in EXCLUSIONS/NOT INCLUDED.
3) not_specified = no mention anywhere (do NOT infer exclusion on silence).

ALTERNATES:
- If CANDIDATE_SCOPE contains alternate rows, set status and price for those using the dollar amount (ADD positive, DEDUCT negative).` };
    content.push(instruct);
    // Preface describing the extracted text format to reduce confusion
    const preface: TextBlockParam = { type: 'text', text: `SOURCE FORMAT (READ CAREFULLY):
The following evidence is extracted PDF text from contractor bid proposals. It is provided as sequential text lines per page; lines may be broken across lines or hyphenated, and bullets/prefixes (•, -, a., 1.) may appear. Some tables may be rendered as CSV. Treat each '=== DOCUMENT: ... ===' block as sequential text from the same file.

WHAT TO IGNORE COMPLETELY:
- Letterheads, addresses, phone/email, license lines
- Document references and headers: Bid Documents, Drawings, Specifications, Sheets/Sheet No., Schedule, Proposal #, Page X, Project Name
- Clarifications, assumptions, warranty paragraphs, thanks/salutations, boilerplate

WHAT TO USE AS EVIDENCE:
- Scope of Work / Inclusions / Equipment lists and installation descriptions
- SOV/equipment tables
- Explicit EXCLUSIONS / NOT INCLUDED sections for exclusions
- Alternates under 'ADD ALTERNATE(S)' or 'Alternates' headers (capture description and amount when present)

NORMALIZATION RULES:
- Join split phrases; ignore brand names and quantities; ignore minor wording variants
- Map findings to the CLOSEST item in CANDIDATE_SCOPE and use that exact name
- Totals may appear as 'BASE BID', 'BASE PRICE', 'BID AMOUNT', or 'TOTAL' with a dollar amount; prefer BASE BID if multiple
` };
    content.push(preface);
    try { console.log('[prompt] preface_included', true); } catch {}
    const candBlock: TextBlockParam = { type: 'text', text: `CANDIDATE_SCOPE (unified across all bids):\n${candidateUnionFinal.map((s,i)=>`${i+1}. ${s}`).join('\n')}` };
    content.push(candBlock);

    // Debug: Log scope items being sent to Claude
    try { console.log(`[Pass2-Scope] ${contractorName} - Sending ${candidateUnionFinal.length} scope items:`, candidateUnionFinal.slice(0, 10)); } catch {}

    content.push({ type: 'text', text: `--- Contractor: ${contractorName} (id ${b.contractor_id || 'unassigned'}) ---` });
    const docs = byBidDocs[b.id] || { texts: [] };
    // Limit evidence to ~30k tokens worth of chars
    let accChars = 0;
    let combinedEvidence = '';
    const explicitExclusions: string[] = [];
    const explicitInclusions: string[] = [];
    const explicitAlternates: string[] = [];

    // SIMPLIFIED APPROACH: Send raw text with minimal filtering (like Claude chat)
    for (const c of docs.texts) {
      if (accChars > 200_000) break; // Allow more text

      const lines = c.text.split(/\r?\n/);
      let section: string | null = null;
      const kept: string[] = [];
      let filteredCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Detect section headers
        const sec = detectSection(line);
        if (sec) {
          section = sec;
          kept.push(`\n=== ${sec.toUpperCase()} SECTION ===`);
          continue;
        }

        // Track exclusions/inclusions for structured block
        if (section === 'exclusions' && trimmed.length > 5) {
          const cleaned = trimmed.replace(/^\s*[\d\-\*•]+[\.\)]*\s*/, '');
          if (cleaned) explicitExclusions.push(cleaned);
        }
        if (section === 'inclusions' && trimmed.length > 5) {
          const cleaned = trimmed.replace(/^\s*[\d\-\*•]+[\.\)]*\s*/, '');
          if (cleaned) explicitInclusions.push(cleaned);
        }
        if (section === 'alternates' && trimmed.length > 3) {
          const cleaned = trimmed.replace(/^\s*[\d\-\*•]+[\.\)]*\s*/, '');
          if (cleaned) explicitAlternates.push(cleaned);
        }

        // ONLY filter obvious junk (addresses, company names, phone numbers)
        // Keep EVERYTHING else - let Claude decide
        if (isJunkLine(line)) {
          filteredCount++;
          continue;
        }

        kept.push(line);
      }

      const fullText = kept.join('\n');
      const snippet = fullText.length > 10000 ? fullText.slice(0, 10000) : fullText; // Increased from 8000
      const t: TextBlockParam = { type: 'text', text: `=== DOCUMENT: ${c.name} ===\n${snippet}\n` };
      content.push(t);
      accChars += t.text.length;
      combinedEvidence += '\n' + snippet;

      // Debug: log evidence stats with filter count
      try { console.log(`[Pass2-Evidence] ${contractorName} - kept ${kept.length} lines (filtered ${filteredCount}), ${fullText.length} chars from ${c.name}`); } catch {}
    }

    // Debug: Log sample of evidence to verify scope items are present
    try {
      const evidenceSample = combinedEvidence.split('\n').slice(0, 20).join('\n');
      console.log(`[Pass2-Evidence-Sample] ${contractorName} - First 20 lines of evidence:`, evidenceSample.substring(0, 500));
    } catch {}

    // Add structured exclusions/inclusions/alternates as separate guidance block
    if (explicitExclusions.length > 0 || explicitInclusions.length > 0) {
      let structuredBlock = '\n=== STRUCTURED QUALIFICATIONS ===\n';
      if (explicitInclusions.length > 0) {
        structuredBlock += `EXPLICITLY INCLUDED ITEMS (mark as 'included'):\n${explicitInclusions.slice(0, 50).map((x, i) => `${i+1}. ${x}`).join('\n')}\n\n`;
      }
      if (explicitExclusions.length > 0) {
        structuredBlock += `EXPLICITLY EXCLUDED ITEMS (mark as 'excluded' ONLY if they match a candidate scope item):\n${explicitExclusions.slice(0, 50).map((x, i) => `${i+1}. ${x}`).join('\n')}\n\n`;
        structuredBlock += `IMPORTANT: Items NOT in this exclusions list should be marked 'not_specified', NOT 'excluded'.\n`;
      }
      content.push({ type: 'text', text: structuredBlock });
      accChars += structuredBlock.length;
    }
    if (explicitAlternates.length > 0) {
      const altsBlock = `\n=== EXPLICIT ALTERNATES (ALSO ADD TO items WITH PRICE) ===\n${explicitAlternates.slice(0,100).map((x,i)=>`${i+1}. ${x}`).join('\n')}\n`;
      content.push({ type: 'text', text: altsBlock });
      accChars += altsBlock.length;
    }
    // If evidence is too thin, add lenient fallback blocks using raw cleaned text
    const evidenceChars = (content as ContentBlockParam[]).reduce((acc, b) => acc + (b.type === 'text' ? (((b as TextBlockParam).text || '').length) : 0), 0);
    try { console.log(`[Pass2-Qual] ${contractorName} alternates_found=`, explicitAlternates.length); } catch {}
    if (evidenceChars < 1500) {
      for (const c of docs.texts) {
        if (accChars > 160_000) break;
        const raw = cleanEvidence(c.text);
        const add = raw.slice(0, 3000);
        const t: TextBlockParam = { type: 'text', text: `=== RAW EXTRACT (lenient): ${c.name} ===\n${add}` };
        content.push(t);
        accChars += t.text.length;
        combinedEvidence += '\n' + add;
        if (accChars > 40_000) break; // keep small fallback footprint
      }
      try { console.log('[level/worker] fallback_lenient', true); } catch {}
    }
    // Also scan all raw docs (untrimmed) for a more reliable total detection
    const allDocsRaw = (docs.texts || []).map(t => t.text).join('\n').slice(0, 200000);
    const detectedTotal = (combinedEvidence ? findTotalInText(combinedEvidence) : null) || (allDocsRaw ? findTotalInText(allDocsRaw) : null);
    try { console.log(`[Pass2-Total] ${contractorName} detected_total=`, detectedTotal); } catch {}

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
    // DEBUG: visibility into inputs and scope fed to the model
    try {
      const evidenceChars2 = (content as ContentBlockParam[]).reduce((acc, b) => acc + (b.type === 'text' ? ((b as TextBlockParam).text?.length || 0) : 0), 0);
      // Only log limited preview to avoid leaking large payloads
      const preview = (content as ContentBlockParam[])
        .filter(b => b.type === 'text')
        .slice(0, 5)
        .map(b => (b as TextBlockParam).text?.slice(0, 300) || '')
        .join('\n---\n');
      console.log('[level/worker] scope_count', candidateUnionFinal.length);
      console.log('[level/worker] scope_sample', candidateUnionFinal.slice(0, 25));
      console.log('[level/worker] evidence_chars', evidenceChars2);
      console.log('[level/worker] evidence_preview', preview);
      // Persist debug audit to processing_jobs.meta (truncated)
      const metaDbg = {
        ts: new Date().toISOString(),
        contractor: contractorName,
        scope_count: candidateUnionFinal.length,
        scope_sample: candidateUnionFinal.slice(0, 25),
        evidence_chars: evidenceChars2,
        evidence_preview: preview,
      };
      const currentMeta = (job.meta ?? {}) as Record<string, unknown>;
      await supabase.from('processing_jobs').update({ meta: { ...currentMeta, debug: metaDbg } }).eq('id', job.id);
    } catch {}
    const system = `You are a construction estimator building a Division-level bid leveling matrix. Ignore letterheads, addresses, and proposal boilerplate. Focus on Scope of Work, Inclusions/Exclusions/Alternates/Allowances, equipment lists and SOV tables. When listing alternates, set candidate_index where possible and include price in the item. Strict JSON only.`;

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
    let parsed = tryParse(text) || tryParse((text.match(/\{[\s\S]*\}/)?.[0] || '')) || { items: [], qualifications: {}, total: null, unmapped: [] } as { items?: PerItem[]; qualifications?: Qual; total?: number|null; unmapped?: Unmapped[] };
    let items = Array.isArray(parsed.items)
      ? parsed.items.filter(x => typeof (x as any)?.status === 'string' && (
          typeof (x as any)?.name === 'string' || typeof (x as any)?.candidate_index === 'number'
        ))
      : [];
    // Canonicalize item names to dictionary
    for (const it of items) {
      const mapped = canonize(scopeIndex, it.name);
      if (mapped) it.name = mapped;
    }
    // Enforce candidate_scope only; move others to unmapped
    const candidateSet = new Set(candidateUnionFinal.map(s => normalizeScope(s)));
    const candidateArray = [...candidateSet];

    // Simple division-agnostic fuzzy matcher
    const STOPWORDS = new Set<string>([
      'furnish','install','provide','provided','providing','supply','supplied','includes','including','include','with','and','or','for','of','the','a','an','by','others','new','existing','system','systems','unit','units','type','per','as','shown','on','per','perplans','plan','plans','above','scope','work','complete','all'
    ]);
    const BRAND_WORDS = new Set<string>(['daikin','marley','greenheck','panasonic','bacnet']);
    const normForMatch = (s: string) => s
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z\s/]/g, ' ') // keep slashes for VRF/VRV style
      .replace(/\s+/g, ' ')
      .trim();
    const stem = (w: string) => w.replace(/(ers|ies|s)$/,'');
    const tokens = (s: string) => new Set(
      normForMatch(s)
        .split(' ')
        .filter(w => w.length > 2 && !STOPWORDS.has(w) && !BRAND_WORDS.has(w))
        .map(stem)
    );
    const jaccard = (a: Set<string>, b: Set<string>) => {
      let inter = 0; for (const t of a) if (b.has(t)) inter++;
      const union = new Set<string>([...a, ...b]).size || 1;
      return inter / union;
    };
    const nearestCandidate = (name: string): string | null => {
      const ta = tokens(name);
      let best = 0; let bestName: string | null = null;
      for (const cand of candidateArray) {
        const tb = tokens(cand);
        if (ta.size && [...ta].every(t => tb.has(t))) { best = 1; bestName = cand; break; }
        const score = jaccard(ta, tb);
        if (score > best) { best = score; bestName = cand; }
      }
      return best >= 0.2 ? (bestName || null) : null;
    };
    const kept: PerItem[] = [];
    const dropped: Unmapped[] = [];
    // Helper to parse alternates like "add alternate ... $ 7,600" or "deduct alternate ... < $ 4,200 >"
    const parseAlt = (s: string): { name: string; price: number|null } | null => {
      const text = s.trim();
      const m = text.match(/\$\s*<?\s*([0-9][\d,\s]*(?:\.\d{2})?)/i);
      if (!m) return null;
      const num = Number((m[1] || '').replace(/[\s,]/g, ''));
      if (!Number.isFinite(num)) return null;
      const neg = /\b(deduct)\b|<\s*\$/i.test(text);
      const price = neg ? -num : num;
      const norm = normalizeAlternateTitle(text) || 'Alternate';
      return { name: norm, price };
    };
    for (const it of items) {
      const ev = (typeof (it as unknown as { evidence?: string }).evidence === 'string') ? (it as unknown as { evidence?: string }).evidence as string : '';
      // Prefer explicit candidate_index from the model when provided
      const idxRaw = (it as unknown as { candidate_index?: unknown }).candidate_index as unknown;
      let mappedDisplay: string | null = null;
      if (typeof idxRaw === 'number' && Number.isFinite(idxRaw)) {
        const idx = Math.round(idxRaw);
        if (idx >= 1 && idx <= candidateUnionFinal.length) mappedDisplay = candidateUnionFinal[idx - 1];
      }
      // If no index, fall back to name mapping (if present)
      if (!mappedDisplay) {
        const nm = (it as any)?.name as string | undefined;
        if (typeof nm === 'string' && nm) mappedDisplay = mapToCandidate(nm) || nearestCandidate(nm);
      }
      if (mappedDisplay) {
        it.name = mappedDisplay; // align to displayed candidate row
        kept.push(it);
      } else if (candidateSet.has(normalizeScope(it.name))) {
        kept.push(it);
      } else {
        dropped.push({ name: it.name, evidence: ev });
      }
    }
    // Ensure alternates appear as items with price even if model missed them
    if (explicitAlternates.length) {
      for (const a of explicitAlternates) {
        const parsedAlt = parseAlt(a);
        if (!parsedAlt) continue;
        const exists = kept.some(k => normalizeScope(k.name) === normalizeScope(parsedAlt.name));
        if (!exists) kept.push({ name: parsedAlt.name, status: 'not_specified', price: parsedAlt.price });
      }
      items = kept;
    }
    // Fill in any missing rows with not_specified, then collapse duplicates with precedence: included > excluded > not_specified
    const precedence: Record<string, number> = { included: 3, excluded: 2, not_specified: 1 } as const;
    const collapsedMap = new Map<string, PerItem>();
    // pre-fill all rows as not_specified
    for (let i = 0; i < candidateUnionFinal.length; i++) {
      const name = candidateUnionFinal[i];
      const key = normalizeScope(name);
      collapsedMap.set(key, { name, status: 'not_specified', price: null });
    }
    for (const it of kept) {
      const key = normalizeScope(it.name);
      const prev = key ? collapsedMap.get(key) : undefined;
      if (!key) continue;
      if (!prev || precedence[it.status] > precedence[prev.status]) {
        collapsedMap.set(key, it);
      } else if (prev && prev.price == null && typeof it.price === 'number') {
        // keep better price if previous had none
        prev.price = it.price;
      }
    }
    // Use only kept items mapped to candidate scope
    items = Array.from(collapsedMap.values());
    try {
      const toLog: Array<{ name?: string }> = Array.isArray(parsed.items) ? (parsed.items as Array<{ name?: string }>) : [];
      const sampleNames = toLog.slice(0,5).map(it => it?.name || '').filter(Boolean);
      console.log('[level/worker] parsed_items', toLog.length, 'kept', kept.length, 'sample', sampleNames);
    } catch {}
    // Persist raw response preview for audit
    try {
      const rawPreview = (text || '').slice(0, 10_000);
      const currentMeta = (job.meta ?? {}) as Record<string, unknown>;
      const prevDebug = (currentMeta.debug || {}) as Record<string, unknown>;
      await supabase.from('processing_jobs').update({ meta: { ...currentMeta, debug: { ...prevDebug, raw_response_preview: rawPreview } } }).eq('id', job.id);
    } catch {}

    // If model returned zero items, retry once with fully lenient evidence (raw cleaned text blocks)
    if (kept.length === 0 && items.length === 0) {
      try { console.log('[level/worker] retry_lenient', true); } catch {}
      const content2: ContentBlockParam[] = [];
      content2.push(instruct);
      content2.push({ type: 'text', text: `CANDIDATE_SCOPE (unified across all bids):\n${candidateUnionFinal.map((s,i)=>`${i+1}. ${s}`).join('\n')}` });
      content2.push({ type: 'text', text: `--- Contractor: ${contractorName} (id ${b.contractor_id || 'unassigned'}) ---` });
      // Re-add structured qualifications in retry
      if (explicitExclusions.length > 0 || explicitInclusions.length > 0) {
        let structuredBlock = '\n=== STRUCTURED QUALIFICATIONS ===\n';
        if (explicitInclusions.length > 0) {
          structuredBlock += `EXPLICITLY INCLUDED ITEMS:\n${explicitInclusions.slice(0, 50).map((x, i) => `${i+1}. ${x}`).join('\n')}\n\n`;
        }
        if (explicitExclusions.length > 0) {
          structuredBlock += `EXPLICITLY EXCLUDED ITEMS:\n${explicitExclusions.slice(0, 50).map((x, i) => `${i+1}. ${x}`).join('\n')}\n\n`;
        }
        content2.push({ type: 'text', text: structuredBlock });
      }
      let acc2 = 0;
      for (const c of docs.texts) {
        if (acc2 > 160_000) break;
        const raw = cleanEvidence(c.text);
        const add = raw.slice(0, 4000);
        content2.push({ type: 'text', text: `=== RAW EXTRACT (retry): ${c.name} ===\n${add}` });
        acc2 += add.length;
      }
      try {
        const r2 = await callClaudeWithRetry();
        const m2 = r2 as unknown as { content?: Array<{ type: string; text?: string }> };
        const blk2 = Array.isArray(m2.content) ? (m2.content.find((bb: unknown) => (typeof bb === 'object' && bb !== null && (bb as { type?: string }).type === 'text' && typeof (bb as { text?: unknown }).text === 'string')) as { type: string; text?: string } | undefined) : undefined;
        const txt2 = blk2?.text || '{}';
        parsed = tryParse(txt2) || tryParse((txt2.match(/\{[\s\S]*\}/)?.[0] || '')) || { items: [], qualifications: {}, total: null, unmapped: [] } as { items?: PerItem[]; qualifications?: Qual; total?: number|null; unmapped?: Unmapped[] };
        items = Array.isArray(parsed.items)
          ? parsed.items.filter(x => typeof (x as any)?.status === 'string' && (
              typeof (x as any)?.name === 'string' || typeof (x as any)?.candidate_index === 'number'
            ))
          : [];
        const kept2: PerItem[] = [];
        const dropped2: Unmapped[] = [];
        for (const it of items) {
          const ev = (typeof (it as unknown as { evidence?: string }).evidence === 'string') ? (it as unknown as { evidence?: string }).evidence as string : '';
          const idxRaw2 = (it as unknown as { candidate_index?: unknown }).candidate_index as unknown;
          let mappedDisplay: string | null = null;
          if (typeof idxRaw2 === 'number' && Number.isFinite(idxRaw2)) {
            const idx2 = Math.round(idxRaw2);
            if (idx2 >= 1 && idx2 <= candidateUnionFinal.length) mappedDisplay = candidateUnionFinal[idx2 - 1];
          }
          if (!mappedDisplay) {
            const nm2 = (it as any)?.name as string | undefined;
            if (typeof nm2 === 'string' && nm2) mappedDisplay = mapToCandidate(nm2) || nearestCandidate(nm2);
          }
          if (mappedDisplay) { it.name = mappedDisplay; kept2.push(it); }
          else if (candidateSet.has(normalizeScope(it.name))) kept2.push(it);
          else dropped2.push({ name: it.name, evidence: ev });
        }
        // After retry, collapse duplicates per candidate row
        const precedence2: Record<string, number> = { included: 3, excluded: 2, not_specified: 1 } as const;
        const collapsedMap2 = new Map<string, PerItem>();
        // pre-fill all rows
        for (let i = 0; i < candidateUnionFinal.length; i++) {
          const name = candidateUnionFinal[i];
          const key = normalizeScope(name);
          collapsedMap2.set(key, { name, status: 'not_specified', price: null });
        }
        for (const it2 of kept2) {
          const key2 = normalizeScope(it2.name);
          const prev2 = key2 ? collapsedMap2.get(key2) : undefined;
          if (!key2) continue;
          if (!prev2 || precedence2[it2.status] > precedence2[prev2.status]) collapsedMap2.set(key2, it2);
          else if (prev2 && prev2.price == null && typeof it2.price === 'number') prev2.price = it2.price;
        }
        items = Array.from(collapsedMap2.values());
        try {
          const toLog2: Array<{ name?: string }> = Array.isArray(parsed.items) ? (parsed.items as Array<{ name?: string }>) : [];
          const sampleNames2 = toLog2.slice(0,5).map(it => it?.name || '').filter(Boolean);
          console.log('[level/worker] parsed_items_retry', toLog2.length, 'kept', kept2.length, 'sample', sampleNames2);
        } catch {}
      } catch {}
    }
    // Merge explicit alternates into qualifications in a non-duplicating, division-agnostic way
    const mergeQual = (q: Qual | undefined): Qual => {
      const out: Qual = q ? { ...q } : {};
      const alts = new Set<string>(Array.isArray(out.alternates) ? out.alternates : []);
      for (const a of explicitAlternates) { if (a && a.length > 2) alts.add(a); }
      if (alts.size) out.alternates = Array.from(alts).slice(0, 100);
      return out;
    };
    const cidKey = b.contractor_id || 'unassigned';
    per[cidKey] = { items: items, qualifications: mergeQual(parsed.qualifications), unmapped: parsed.unmapped, total: (typeof parsed.total === 'number' ? parsed.total : detectedTotal) ?? null };
    unmappedPer[cidKey] = [...(parsed.unmapped || []), ...dropped];
    done += 1;
    await supabase.from('processing_jobs').update({ batches_done: done, progress: Math.min(90, Math.round((done / batches.length) * 85) + 5) }).eq('id', job.id);
    // dynamic inter-batch delay based on input size to respect 40k tokens/min
    const usedTokens = (content as ContentBlockParam[]).reduce((acc, cb) => acc + (cb.type === 'text' ? ((cb as TextBlockParam).text?.length || 0) : 0), 0) / 4;
    const minDelayMs = Math.ceil((usedTokens / 40_000) * 60_000); // scale to minute window
    await new Promise(r => setTimeout(r, Math.max(1500, Math.min(20_000, minDelayMs))));
  }

  // Merge pass → final division-level report
  // Use the final unified candidate scope (after Pass 1 + canonicalization)
  const scopeSet = new Set<string>(candidateUnionFinal);
  Object.values(per).forEach(p => (p.items || []).forEach(it => { const n = normalizeScope(it.name || ''); if (n) scopeSet.add(n); }));
  const scopeItems = Array.from(scopeSet);
  const matrix: NonNullable<Report['matrix']> = {};
  for (const s of scopeItems) {
    matrix[s] = {};
    for (const b of bidList) {
      const cid = b.contractor_id || 'unassigned';
      const arr = per[cid]?.items || [];
      const found = arr.find((it: { name: string; status?: 'included'|'excluded'|'not_specified'; price?: number|null }) => normalizeScope(it.name) === s);
      // Default to not_specified unless the model explicitly sets included/excluded
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
    if (typeof (per[cid]?.total) === 'number') total = per[cid]?.total as number;
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
