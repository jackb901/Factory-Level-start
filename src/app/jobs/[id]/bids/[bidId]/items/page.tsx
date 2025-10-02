"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { levelItem } from "@/lib/level";

type Item = { id: string; raw_text: string | null; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null };

export default function BidItemsPage() {
  const { id, bidId } = useParams<{ id: string; bidId: string }>();
  const supabase = getSupabaseClient();
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = 50;
  const [levelling, setLevelling] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = "/login"; return; }
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await supabase
        .from('line_items')
        .select('id,raw_text,qty,unit,unit_cost,total', { count: 'exact' })
        .eq('bid_id', bidId)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (!error) {
        setItems((data as Item[]) || []);
        setTotalCount(count || 0);
      }
      setLoading(false);
    })();
  }, [page, bidId, supabase]);

  const pages = Math.ceil(totalCount / pageSize) || 1;

  const levelAll = async () => {
    setLevelling(true);
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = "/login"; return; }
      // Fetch all items ids+fields in chunks
      let from = 0;
      const batch = 500;
      // unknown total; iterate until empty
      // First, get count
      const { count } = await supabase.from('line_items').select('id', { count: 'exact', head: true }).eq('bid_id', bidId);
      const total = count || 0;
      while (from < total) {
        const to = Math.min(from + batch - 1, total - 1);
        const { data } = await supabase
          .from('line_items')
          .select('id,raw_text,qty,unit,unit_cost,total,user_id')
          .eq('bid_id', bidId)
          .order('created_at', { ascending: false })
          .range(from, to);
        const rows = (data || []) as Array<{id:string; raw_text:string|null; qty:number|null; unit:string|null; unit_cost:number|null; total:number|null; user_id:string}>;
        const updates = rows.map(r => {
          const out = levelItem({ raw_text: r.raw_text, qty: r.qty, unit: r.unit, unit_cost: r.unit_cost, total: r.total });
          return { id: r.id, user_id: r.user_id, canonical_name: out.canonical_name, unit: out.unit, qty: out.qty, unit_cost: out.unit_cost, total: out.total };
        });
        if (updates.length) {
          // Upsert per-row updates to satisfy RLS check
          const { error } = await supabase.from('line_items').upsert(updates, { onConflict: 'id' });
          if (error) { console.error(error.message); break; }
        }
        from += batch;
      }
      // reload current page
      setPage(0);
    } finally {
      setLevelling(false);
    }
  };

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Bid Items</h1>
      <div className="flex items-center gap-2">
        <button className="border rounded px-3 py-1" onClick={() => window.location.href = `/jobs/${id}`}>Back to Job</button>
        <div className="text-sm text-gray-600">{totalCount} items</div>
        <button className="border rounded px-3 py-1 disabled:opacity-50" disabled={levelling || totalCount===0} onClick={levelAll}>{levelling ? 'Levelling…' : 'Level Items'}</button>
      </div>
      {loading ? <p>Loading…</p> : (
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">Description</th>
                <th className="p-2">Qty</th>
                <th className="p-2">Unit</th>
                <th className="p-2">Unit Cost</th>
                <th className="p-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className="border-b">
                  <td className="p-2 align-top whitespace-pre-wrap">{it.raw_text}</td>
                  <td className="p-2">{it.qty ?? ''}</td>
                  <td className="p-2">{it.unit ?? ''}</td>
                  <td className="p-2">{it.unit_cost ?? ''}</td>
                  <td className="p-2">{it.total ?? ''}</td>
                </tr>
              ))}
              {!items.length && (
                <tr><td className="p-2 text-gray-600" colSpan={5}>No items.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2 items-center">
        <button className="border rounded px-3 py-1" disabled={page<=0} onClick={() => setPage(p => Math.max(0, p-1))}>Prev</button>
        <span className="text-sm">Page {page+1} / {pages}</span>
        <button className="border rounded px-3 py-1" disabled={page+1>=pages} onClick={() => setPage(p => p+1)}>Next</button>
      </div>
    </main>
  );
}
