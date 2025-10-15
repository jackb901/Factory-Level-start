import * as XLSX from 'xlsx';
import Papa from 'papaparse';

export type ExtractedItem = {
  raw_text: string;
  qty: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function extractFromBuffer(name: string, buf: ArrayBuffer): Promise<ExtractedItem[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(Buffer.from(buf), { type: 'buffer' });
    const wsName = wb.SheetNames[0];
    if (!wsName) return [];
    const ws = wb.Sheets[wsName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as (string | number | boolean | null)[][];
    if (!rows.length) return [];
    const headers = (rows[0] ?? []).map(c => String(c ?? ''));
    const find = (keys: string[]) => headers.findIndex(h => keys.includes(h.toLowerCase().replace(/[^a-z0-9]+/g, '')));
    const idxDesc = 0;
    const idxQty = find(['qty','quantity','qnty','amount','noof','count','units']);
    const idxUnit = find(['unit','uom','unitofmeasure','measure','unitsymbol']);
    const idxUnitCost = find(['unitcost','rate','unitprice','priceeach','costeach','cost','price']);
    const idxTotal = find(['total','amounttotal','extended','extension','lineamount','linetotal','subtotal']);
    const out: ExtractedItem[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const raw_text = String(r[idxDesc] ?? '');
      const qty = idxQty >= 0 ? toNum(r[idxQty]) : null;
      const unit = idxUnit >= 0 ? String(r[idxUnit] ?? '') || null : null;
      const unit_cost = idxUnitCost >= 0 ? toNum(r[idxUnitCost]) : null;
      const total = idxTotal >= 0 ? toNum(r[idxTotal]) : null;
      if (raw_text || qty !== null || total !== null) out.push({ raw_text, qty, unit, unit_cost, total });
      if (out.length >= 1500) break;
    }
    return out;
  }
  if (lower.endsWith('.csv')) {
    const text = Buffer.from(buf).toString('utf8');
    const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
    const fields = parsed.meta.fields || [];
    const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const map: Record<string, string | undefined> = {};
    const findField = (cands: string[]) => fields.find(f => cands.includes(norm(f)));
    map.description = fields[0];
    map.qty = findField(['qty','quantity','qnty','amount','noof','count','units']);
    map.unit = findField(['unit','uom','unitofmeasure','measure','unitsymbol']);
    map.unit_cost = findField(['unitcost','rate','unitprice','priceeach','costeach','cost','price']);
    map.total = findField(['total','amounttotal','extended','extension','lineamount','linetotal','subtotal']);
    const out: ExtractedItem[] = [];
    for (const row of parsed.data || []) {
      const get = (k?: string) => (k ? (row as Record<string, unknown>)[k] : undefined);
      const raw_text = String(get(map.description) ?? '');
      const qty = toNum(get(map.qty));
      const unit = get(map.unit) ? String(get(map.unit) as unknown) : null;
      const unit_cost = toNum(get(map.unit_cost));
      const total = toNum(get(map.total));
      if (raw_text || qty !== null || total !== null) out.push({ raw_text, qty, unit, unit_cost, total });
      if (out.length >= 1500) break;
    }
    return out;
  }
  if (lower.endsWith('.pdf')) {
    // Ensure DOMMatrix exists for pdfjs in Node
    if (typeof (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
      try {
        const dm: unknown = await import('dommatrix');
        const anyDm = dm as { DOMMatrix?: unknown; default?: unknown };
        (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix = anyDm.DOMMatrix ?? anyDm.default ?? dm;
      } catch {
        // best-effort; if missing, pdf-parse may throw and the caller will surface a clear error
      }
    }
    const { pdf: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(Buffer.from(buf));
    const lines = (data.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5000);
    return lines.map(l => ({ raw_text: l, qty: null, unit: null, unit_cost: null, total: null })).slice(0, 1500);
  }
  return [];
}
