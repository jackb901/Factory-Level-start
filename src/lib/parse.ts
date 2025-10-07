import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

export type ParsedItem = {
  raw_text: string;
  canonical_name: string | null;
  qty: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
};

function normalizeHeader(h: unknown): string {
  return String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const CANDIDATES = {
  description: ['description','desc','scope','scopeofwork','item','itemdescription','work','workdescription','details'],
  qty: ['qty','quantity','qnty','amount','noof','count','units'],
  unit: ['unit','uom','unitofmeasure','measure','unitsymbol'],
  unit_cost: ['unitcost','rate','unitprice','priceeach','costeach','cost','price'],
  total: ['total','amounttotal','extended','extension','lineamount','linetotal','subtotal']
};

type HeaderMap = { description?: string; qty?: string; unit?: string; unit_cost?: string; total?: string };

function detectHeaders(headers: string[]): HeaderMap {
  const norm = headers.map(h => ({ raw: h, key: normalizeHeader(h) }));
  const map: HeaderMap = {};
  for (const [field, candidates] of Object.entries(CANDIDATES) as [keyof typeof CANDIDATES, string[]][]) {
    const found = norm.find(n => candidates.includes(n.key));
    if (found) {
      map[field as keyof HeaderMap] = found.raw;
    }
  }
  // fallback: use first column for description if nothing matched
  if (!map.description && headers.length) map.description = headers[0];
  return map;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function parseCSV(file: Blob, onProgress?: (p: number) => void): Promise<ParsedItem[]> {
  const text = await file.text();
  const out = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
  if (!out.meta.fields) return [];
  const headers = out.meta.fields;
  const map = detectHeaders(headers);
  const data = (out.data || []) as Record<string, unknown>[];
  const items = data.map((row: Record<string, unknown>) => {
    const get = (key?: string): unknown => (key ? row[key] : undefined);
    return {
      raw_text: String(get(map.description) ?? ''),
      canonical_name: null,
      qty: toNum(get(map.qty)),
      unit: get(map.unit) !== undefined && get(map.unit) !== null && String(get(map.unit) as unknown) !== ''
        ? String(get(map.unit) as unknown)
        : null,
      unit_cost: toNum(get(map.unit_cost)),
      total: toNum(get(map.total))
    } as ParsedItem;
  }).filter(i => i.raw_text || i.total !== null || i.qty !== null);
  if (onProgress) onProgress(100);
  return items;
}

export async function parseXLSX(file: Blob, onProgress?: (p: number) => void): Promise<ParsedItem[]> {
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: 'array' });
  const wsName = wb.SheetNames[0];
  if (!wsName) return [];
  const ws = wb.Sheets[wsName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as (string | number | boolean | null)[][];
  if (!rows.length) return [];
  const headerRowCells = rows[0] ?? [];
  const headerRow = headerRowCells.map(cell => String(cell ?? ''));
  const map = detectHeaders(headerRow);
  const items: ParsedItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const getByHeader = (h?: string): unknown => {
      if (!h) return '';
      const idx = headerRow.findIndex(x => x === h);
      return idx >= 0 ? r[idx] : '';
    };
    const raw_text = String(getByHeader(map.description) ?? '');
    const qty = toNum(getByHeader(map.qty));
    const unitVal = getByHeader(map.unit);
    const unit = unitVal !== undefined && unitVal !== null && String(unitVal) !== '' ? String(unitVal) : null;
    const unit_cost = toNum(getByHeader(map.unit_cost));
    const total = toNum(getByHeader(map.total));
    if (raw_text || qty !== null || total !== null) {
      items.push({ raw_text, canonical_name: null, qty, unit, unit_cost, total });
    }
    if (onProgress) onProgress(Math.min(99, Math.round((i / rows.length) * 100)));
  }
  if (onProgress) onProgress(100);
  return items;
}

type PdfJsTextItem = { str?: string; transform?: number[] };
type PdfJsTextContent = { items: PdfJsTextItem[] };
type PDFDocumentProxyLite = { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<unknown> }> };

async function parsePDF(file: Blob, onProgress?: (p: number) => void): Promise<ParsedItem[]> {
  // Point to the worker bundled with pdfjs-dist to avoid CDN/CORS issues.
  // Next.js will rewrite this to a proper URL at runtime.
  // Example per pdfjs docs for ESM bundlers:
  // https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#3-how-to-use-pdfjs-in-a-web-application
  GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const ab = await file.arrayBuffer();
  const doc = await getDocument({ data: ab }).promise as unknown as PDFDocumentProxyLite;
  const items: ParsedItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent() as unknown as PdfJsTextContent;
    // Group by text line via y coordinate rounding
    const lines = new Map<number, string[]>();
    for (const it of tc.items) {
      if (typeof it.str === 'string') {
        const t = it as PdfJsTextItem;
        const y = Math.round(((t.transform && t.transform[5]) || 0));
        const arr = lines.get(y) || [];
        arr.push(t.str!);
        lines.set(y, arr);
      }
    }
    for (const [, parts] of Array.from(lines.entries()).sort((a,b)=>b[0]-a[0])) {
      const line = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      // Heuristic: find trailing currency/number as total
      const m = line.match(/\s([$€£]?\s?[-+]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)[^0-9]*$/);
      const total = m ? toNum(m[1]) : null;
      items.push({ raw_text: line, canonical_name: null, qty: null, unit: null, unit_cost: null, total });
    }
    if (onProgress) onProgress(Math.round((p / doc.numPages) * 100));
  }
  return items;
}

export async function parseFile(file: Blob, name: string, onProgress?: (p: number) => void): Promise<ParsedItem[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return parseCSV(file, onProgress);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseXLSX(file, onProgress);
  if (lower.endsWith('.pdf')) return parsePDF(file, onProgress);
  // Unknown type: try CSV first
  try { return await parseCSV(file, onProgress); } catch {}
  try { return await parseXLSX(file, onProgress); } catch {}
  return [];
}
