import Papa from 'papaparse';
import * as XLSX from 'xlsx';

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
  for (const [field, candidates] of Object.entries(CANDIDATES)) {
    const found = norm.find(n => candidates.includes(n.key));
    if (found) (map as any)[field] = found.raw;
  }
  // fallback: use first text-like column for description
  if (!map.description && headers.length) map.description = headers[0];
  return map;
}

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function parseCSV(file: Blob): Promise<ParsedItem[]> {
  const text = await file.text();
  const out = Papa.parse<Record<string, any>>(text, { header: true, skipEmptyLines: true });
  if (!out.meta.fields) return [];
  const headers = out.meta.fields;
  const map = detectHeaders(headers);
  return (out.data || []).map((row) => ({
    raw_text: String(row[map.description || ''] ?? ''),
    canonical_name: null,
    qty: toNum(row[map.qty || '']),
    unit: row[map.unit || ''] ? String(row[map.unit || '']) : null,
    unit_cost: toNum(row[map.unit_cost || '']),
    total: toNum(row[map.total || ''])
  })).filter(i => i.raw_text || i.total !== null || i.qty !== null);
}

export async function parseXLSX(file: Blob): Promise<ParsedItem[]> {
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: 'array' });
  const wsName = wb.SheetNames[0];
  if (!wsName) return [];
  const ws = wb.Sheets[wsName];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { header: 1, defval: '' });
  if (!rows.length) return [];
  const headerRow = (rows[0] as any[]).map(String);
  const map = detectHeaders(headerRow);
  const items: ParsedItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as any[];
    const getByHeader = (h?: string) => {
      if (!h) return '';
      const idx = headerRow.findIndex(x => x === h);
      return idx >= 0 ? r[idx] : '';
    };
    const raw_text = String(getByHeader(map.description));
    const qty = toNum(getByHeader(map.qty));
    const unit = getByHeader(map.unit) ? String(getByHeader(map.unit)) : null;
    const unit_cost = toNum(getByHeader(map.unit_cost));
    const total = toNum(getByHeader(map.total));
    if (raw_text || qty !== null || total !== null) {
      items.push({ raw_text, canonical_name: null, qty, unit, unit_cost, total });
    }
  }
  return items;
}

export async function parseFile(file: Blob, name: string): Promise<ParsedItem[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return parseCSV(file);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseXLSX(file);
  // Unknown type: try CSV first
  try { return await parseCSV(file); } catch {}
  try { return await parseXLSX(file); } catch {}
  return [];
}
