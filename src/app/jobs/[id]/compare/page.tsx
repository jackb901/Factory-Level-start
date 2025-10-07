"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";

type Bid = { id: string; contractor_id: string | null; division_code: string | null };
type Contractor = { id: string; name: string };
type Division = { code: string; name: string };
type Item = { bid_id: string; total: number | null; qty: number | null; unit_cost: number | null; canonical_name: string | null; raw_text: string | null };

export default function ComparePage() {
  const { id } = useParams<{ id: string }>();
  const supabase = getSupabaseClient();
  const [bids, setBids] = useState<Bid[]>([]);
  const [contractors, setContractors] = useState<Record<string, Contractor>>({});
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDivision, setSelectedDivision] = useState<string>("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = "/login"; return; }
      const { data: bidsData } = await supabase
        .from('bids')
        .select('id,contractor_id,division_code')
        .eq('job_id', id);
      const bs = (bidsData || []) as Bid[];
      setBids(bs);
      const contractorIds = Array.from(new Set(bs.map(b => b.contractor_id).filter(Boolean))) as string[];
      if (contractorIds.length) {
        const { data: cons } = await supabase.from('contractors').select('id,name').in('id', contractorIds);
        const map: Record<string, Contractor> = {};
        (cons || []).forEach(c => { map[c.id] = c as Contractor; });
        setContractors(map);
      }
      const { data: divs } = await supabase.from('csi_divisions').select('code,name').order('code');
      setDivisions((divs || []) as Division[]);
      const bidIds = bs.map(b => b.id);
      if (bidIds.length) {
        const { data: li } = await supabase
          .from('line_items')
          .select('bid_id,total,qty,unit_cost,canonical_name,raw_text')
          .in('bid_id', bidIds);
        setItems((li || []) as Item[]);
      } else {
        setItems([]);
      }
      setLoading(false);
    })();
  }, [id, supabase]);

  const contractorCols = useMemo(() => {
    const ids = Array.from(new Set(bids.map(b => b.contractor_id).filter(Boolean))) as string[];
    return ids.map(cid => ({ id: cid, name: contractors[cid]?.name || 'Contractor' }));
  }, [bids, contractors]);

  const divisionRows = useMemo(() => {
    const codes = Array.from(new Set(bids.map(b => b.division_code || '')));
    const withNames = codes.map(code => ({
      code,
      name: code ? (divisions.find(d => d.code === code)?.name || code) : 'No division'
    }));
    // Sort with empty first, then numeric order
    return withNames.sort((a,b) => (a.code === '' ? -1 : b.code === '' ? 1 : a.code.localeCompare(b.code)));
  }, [bids, divisions]);

  const totalsMap = useMemo(() => {
    const perBid = new Map<string, number>();
    for (const it of items) {
      const t = it.total ?? ((it.qty ?? 0) * (it.unit_cost ?? 0));
      perBid.set(it.bid_id, (perBid.get(it.bid_id) || 0) + (Number.isFinite(t) ? t : 0));
    }
    const out: Record<string, Record<string, number>> = {};
    for (const b of bids) {
      const div = b.division_code || '';
      const con = b.contractor_id || 'unassigned';
      out[div] = out[div] || {};
      out[div][con] = (out[div][con] || 0) + (perBid.get(b.id) || 0);
    }
    return out;
  }, [items, bids]);

  const toCurrency = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

  // Division-focused item-level comparison helpers
  const bidsInDivision = useMemo(() => bids.filter(b => (selectedDivision ? b.division_code === selectedDivision : true)), [bids, selectedDivision]);
  const contractorColsInDiv = useMemo(() => {
    const ids = Array.from(new Set(bidsInDivision.map(b => b.contractor_id).filter(Boolean))) as string[];
    return ids.map(cid => ({ id: cid, name: contractors[cid]?.name || 'Contractor', bidId: bidsInDivision.find(b => b.contractor_id === cid)?.id }));
  }, [bidsInDivision, contractors]);
  const canonicalRows = useMemo(() => {
    if (!selectedDivision) return [] as string[];
    const bidIds = bidsInDivision.map(b => b.id);
    const names = new Set<string>();
    for (const it of items) {
      if (bidIds.includes(it.bid_id)) names.add(it.canonical_name || 'Uncategorized');
    }
    return Array.from(names).sort();
  }, [items, bidsInDivision, selectedDivision]);
  const matrix = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    const bidIds = bidsInDivision.map(b => b.id);
    for (const name of canonicalRows) m[name] = {};
    for (const it of items) {
      if (!bidIds.includes(it.bid_id)) continue;
      const name = it.canonical_name || 'Uncategorized';
      const val = (it.total ?? ((it.qty ?? 0) * (it.unit_cost ?? 0))) || 0;
      m[name][it.bid_id] = (m[name][it.bid_id] || 0) + val;
    }
    return m;
  }, [items, bidsInDivision, canonicalRows]);
  const summary = useMemo(() => {
    const bidIds = bidsInDivision.map(b => b.id);
    const s: Record<string, { includes: number; excludes: number; allowances: number; alternates: number }> = {};
    for (const bidId of bidIds) s[bidId] = { includes: 0, excludes: 0, allowances: 0, alternates: 0 };
    const inc = /\b(include|included|includes)\b/i;
    const exc = /\b(exclude|excluded|excludes|not\s+include)\b/i;
    const allw = /\b(allowance|allowances|allow)\b/i;
    const alt = /\b(alternate|alternates|alt\.)\b/i;
    for (const it of items) {
      if (!bidIds.includes(it.bid_id)) continue;
      const t = it.raw_text || '';
      if (inc.test(t)) s[it.bid_id].includes++;
      if (exc.test(t)) s[it.bid_id].excludes++;
      if (allw.test(t)) s[it.bid_id].allowances++;
      if (alt.test(t)) s[it.bid_id].alternates++;
    }
    return s;
  }, [items, bidsInDivision]);
  const markWinner = async (contractorId: string) => {
    const targetBid = bidsInDivision.find(b => b.contractor_id === contractorId && (b.division_code || '') === (selectedDivision || ''));
    if (!targetBid) return;
    await supabase.from('bids').update({ is_winner: false }).eq('division_code', selectedDivision || null).eq('job_id', id);
    await supabase.from('bids').update({ is_winner: true }).eq('id', targetBid.id);
  };

  const exportCSV = () => {
    const headers = ['Division', ...contractorCols.map(c => c.name)];
    const lines = [headers.join(',')];
    for (const row of divisionRows) {
      const vals = contractorCols.map(c => (totalsMap[row.code]?.[c.id] || 0));
      lines.push([`"${row.code ? `Div ${row.code} - ${row.name}` : 'No division'}"`, ...vals.map(v => v.toFixed(2))].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${id}-comparison.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Comparison</h1>
      <div className="flex gap-2 items-center">
        <button className="border rounded px-3 py-1" onClick={() => window.location.href = `/jobs/${id}`}>Back to Job</button>
        <button className="border rounded px-3 py-1" onClick={exportCSV}>Export CSV</button>
      </div>
      <div className="flex gap-2 items-center">
        <label className="text-sm">Focus CSI Division:</label>
        <select className="border rounded px-2 py-1 bg-white text-black" value={selectedDivision} onChange={(e)=>setSelectedDivision(e.target.value)}>
          <option value="">All divisions</option>
          {divisions.map(d => (
            <option key={d.code} value={d.code}>{`Div ${d.code} — ${d.name}`}</option>
          ))}
        </select>
      </div>
      {loading ? <p>Loading…</p> : (
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">CSI Division</th>
                {contractorCols.map(c => (
                  <th key={c.id} className="p-2">{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {divisionRows.map(row => (
                <tr key={row.code || 'none'} className="border-b">
                  <td className="p-2">{row.code ? `Div ${row.code} — ${row.name}` : 'No division'}</td>
                  {contractorCols.map(c => (
                    <td key={c.id} className="p-2">{toCurrency(totalsMap[row.code]?.[c.id] || 0)}</td>
                  ))}
                </tr>
              ))}
              {!divisionRows.length && (
                <tr><td className="p-2 text-gray-600" colSpan={1 + contractorCols.length}>No data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedDivision && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Division {selectedDivision} — Item-level comparison</h2>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">Canonical Item</th>
                  {contractorColsInDiv.map(c => (
                    <th key={c.id} className="p-2">
                      <div className="flex items-center gap-2">
                        <span>{c.name}</span>
                        <button className="border rounded px-2 py-0.5 text-xs" onClick={()=>markWinner(c.id)}>Mark winner</button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {canonicalRows.map(name => (
                  <tr key={name} className="border-b">
                    <td className="p-2">{name}</td>
                    {contractorColsInDiv.map(c => (
                      <td key={c.id} className="p-2">{toCurrency((matrix[name]?.[c.bidId || ''] || 0))}</td>
                    ))}
                  </tr>
                ))}
                {!canonicalRows.length && (
                  <tr><td className="p-2 text-gray-600" colSpan={1 + contractorColsInDiv.length}>No items.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <h3 className="font-medium">Inclusions / Exclusions summary</h3>
            <ul className="list-disc pl-5 text-sm">
              {contractorColsInDiv.map(c => (
                <li key={c.id}>
                  <span className="font-medium">{c.name}:</span>
                  <span className="ml-2">Includes: {summary[c.bidId || '']?.includes || 0}</span>
                  <span className="ml-2">Excludes: {summary[c.bidId || '']?.excludes || 0}</span>
                  <span className="ml-2">Allowances: {summary[c.bidId || '']?.allowances || 0}</span>
                  <span className="ml-2">Alternates: {summary[c.bidId || '']?.alternates || 0}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
