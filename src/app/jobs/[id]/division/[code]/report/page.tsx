"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";

type Report = {
  division_code: string | null;
  subdivision_id?: string | null;
  contractors?: Array<{ contractor_id: string | null; name: string; total?: number | null }>;
  scope_items?: string[];
  matrix?: Record<string, Record<string, { status: "included" | "excluded" | "not_specified"; price?: number | null }>>;
  qualifications?: Record<string, { includes?: string[]; excludes?: string[]; allowances?: string[]; alternates?: string[]; payment_terms?: string[]; fine_print?: string[] }>;
  recommendation?: { selected_contractor_id?: string | null; rationale?: string; next_steps?: string } | string;
};

export default function DivisionReportPage() {
  const { id, code } = useParams<{ id: string; code: string }>();
  const supabase = getSupabaseClient();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [rawPreview, setRawPreview] = useState<string>("");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = "/login"; return; }
      const { data, error } = await supabase
        .from('bid_level_reports')
        .select('report')
        .eq('job_id', id)
        .eq('division_code', code)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) { setReport(null); setLoading(false); return; }
      const rep = (Array.isArray(data) && data[0] && (data[0] as { report: Report }).report) || null;
      setReport(rep);
      // Fetch latest processing job debug preview for this job/division
      const { data: pj } = await supabase
        .from('processing_jobs')
        .select('meta, created_at')
        .eq('job_id', id)
        .order('created_at', { ascending: false })
        .limit(1);
      let raw: string | undefined;
      if (Array.isArray(pj) && pj[0]) {
        const rec = pj[0] as { meta?: unknown };
        if (rec.meta && typeof rec.meta === 'object') {
          const dbg = (rec.meta as { debug?: { raw_response_preview?: string } }).debug;
          if (dbg && typeof dbg.raw_response_preview === 'string') raw = dbg.raw_response_preview;
        }
      }
      if (typeof raw === 'string') setRawPreview(raw);
      setLoading(false);
    })();
  }, [id, code, supabase]);

  if (loading) return <main className="min-h-dvh p-6 bg-[#0a2540] text-white">Loading…</main>;
  if (!report) return <main className="min-h-dvh p-6 bg-[#0a2540] text-white">No report found. Run LevelStart first.</main>;

  const contractors = Array.isArray(report.contractors) ? report.contractors : [];
  const contractorIds = contractors.map(c => c.contractor_id || 'unassigned');
  const contractorMap: Record<string, string> = {};
  contractors.forEach(c => { contractorMap[c.contractor_id || 'unassigned'] = c.name; });
  const totalsMap: Record<string, number | null | undefined> = {};
  contractors.forEach(c => { totalsMap[c.contractor_id || 'unassigned'] = c.total; });
  const scopeItems = Array.isArray(report.scope_items) && report.scope_items.length
    ? report.scope_items
    : Object.keys((report.matrix as Record<string, unknown>) || {});
  const matrix = (report.matrix && typeof report.matrix === 'object') ? report.matrix : {} as NonNullable<Report['matrix']>;
  const quals = (report.qualifications && typeof report.qualifications === 'object') ? report.qualifications : {} as NonNullable<Report['qualifications']>;

  const toggleRow = (name: string) => setHidden(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <main className="min-h-dvh p-6 space-y-4 bg-[#0a2540] text-white">
      <h1 className="text-2xl font-semibold">Division {code} — Bid Level Report</h1>
      {rawPreview && (
        <div className="rounded border border-white/20 p-3 bg-white/5">
          <button className="border rounded px-2 py-0.5 text-xs" onClick={() => setShowRaw(v => !v)}>
            {showRaw ? 'Hide raw Claude output' : 'Show raw Claude output'}
          </button>
          {showRaw && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs font-mono">
              {rawPreview}
            </pre>
          )}
        </div>
      )}
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="p-2">Scope Item</th>
              {contractorIds.map(cid => (
                <th key={cid} className="p-2">{contractorMap[cid]}</th>
              ))}
            </tr>
            {contractorIds.length > 0 && (
              <tr className="text-left border-b">
                <th className="p-2">Totals</th>
                {contractorIds.map(cid => (
                  <th key={cid} className="p-2 text-center">{totalsMap[cid] != null ? `$${Number(totalsMap[cid]).toLocaleString()}` : '-'}</th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {scopeItems.map(s => (
              hidden[s] ? null : (
                <tr key={s} className="border-b">
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      <button className="border rounded px-2 py-0.5 text-xs" onClick={() => toggleRow(s)}>Hide</button>
                      <span>{s}</span>
                    </div>
                  </td>
                  {contractorIds.map(cid => {
                    const row = (matrix as Record<string, Record<string, { status?: string; price?: number | null }>>)[s] as Record<string, { status?: string; price?: number | null }> | undefined;
                    const cell = row ? row[cid] : undefined;
                    const status = cell?.status || 'not_specified';
                    const price = cell?.price;
                    const color = status === 'included' ? 'bg-green-900/30 text-green-300' : status === 'excluded' ? 'bg-red-900/30 text-red-300' : 'text-gray-300';
                    return <td key={cid} className={`p-2 ${color}`}>{status}{price!=null?` — $${Number(price).toLocaleString()}`:''}</td>;
                  })}
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Qualifications</h2>
        <ul className="list-disc pl-5 text-sm">
          {contractors.map(c => (
            <li key={c.contractor_id || 'unassigned'}>
              <span className="font-medium">{c.name}:</span>
              <span className="ml-2">Includes: {(quals?.[c.contractor_id || 'unassigned']?.includes || []).length}</span>
              <span className="ml-2">Excludes: {(quals?.[c.contractor_id || 'unassigned']?.excludes || []).length}</span>
              <span className="ml-2">Allowances: {(quals?.[c.contractor_id || 'unassigned']?.allowances || []).length}</span>
              <span className="ml-2">Alternates: {(quals?.[c.contractor_id || 'unassigned']?.alternates || []).length}</span>
            </li>
          ))}
        </ul>
      </section>

      {report.recommendation && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Recommendation</h2>
          <p className="text-sm whitespace-pre-wrap">
            {typeof report.recommendation === 'string'
              ? report.recommendation
              : `${report.recommendation?.rationale || ''}${report.recommendation?.next_steps ? `\nNext steps: ${report.recommendation.next_steps}` : ''}`}
          </p>
        </section>
      )}
    </main>
  );
}
