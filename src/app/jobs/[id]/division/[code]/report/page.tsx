"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";

type Report = {
  division_code: string | null;
  contractors: Array<{ contractor_id: string | null; name: string; total?: number | null }>;
  scope_items: string[];
  matrix: Record<string, Record<string, { status: "included" | "excluded" | "not_specified"; price?: number | null }>>;
  qualifications: Record<string, { includes: string[]; excludes: string[]; allowances: string[]; alternates: string[]; payment_terms?: string[] }>;
  recommendation?: string;
};

export default function DivisionReportPage() {
  const { id, code } = useParams<{ id: string; code: string }>();
  const supabase = getSupabaseClient();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = "/login"; return; }
      const { data } = await supabase
        .from('bid_level_reports')
        .select('report')
        .eq('job_id', id)
        .eq('division_code', code)
        .order('created_at', { ascending: false })
        .limit(1);
      const rep = (data && data[0] && (data[0] as { report: Report }).report) || null;
      setReport(rep);
      setLoading(false);
    })();
  }, [id, code, supabase]);

  if (loading) return <main className="p-6">Loading…</main>;
  if (!report) return <main className="p-6">No report found. Run AI Bid Level first.</main>;

  const contractorIds = report.contractors.map(c => c.contractor_id || 'unassigned');
  const contractorMap: Record<string, string> = {};
  report.contractors.forEach(c => { contractorMap[c.contractor_id || 'unassigned'] = c.name; });

  const toggleRow = (name: string) => setHidden(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Division {code} — Bid Level Report</h1>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="p-2">Scope Item</th>
              {contractorIds.map(cid => (
                <th key={cid} className="p-2">{contractorMap[cid]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.scope_items.map(s => (
              hidden[s] ? null : (
                <tr key={s} className="border-b">
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      <button className="border rounded px-2 py-0.5 text-xs" onClick={() => toggleRow(s)}>Hide</button>
                      <span>{s}</span>
                    </div>
                  </td>
                  {contractorIds.map(cid => {
                    const cell = report.matrix?.[s]?.[cid];
                    const status = cell?.status || 'not_specified';
                    const price = cell?.price;
                    const color = status === 'included' ? 'text-green-700' : status === 'excluded' ? 'text-red-700' : 'text-gray-600';
                    return <td key={cid} className={`p-2 ${color}`}>{status}{price!=null?` — $${price.toFixed(2)}`:''}</td>;
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
          {report.contractors.map(c => (
            <li key={c.contractor_id || 'unassigned'}>
              <span className="font-medium">{c.name}:</span>
              <span className="ml-2">Includes: {(report.qualifications?.[c.contractor_id || 'unassigned']?.includes || []).length}</span>
              <span className="ml-2">Excludes: {(report.qualifications?.[c.contractor_id || 'unassigned']?.excludes || []).length}</span>
              <span className="ml-2">Allowances: {(report.qualifications?.[c.contractor_id || 'unassigned']?.allowances || []).length}</span>
              <span className="ml-2">Alternates: {(report.qualifications?.[c.contractor_id || 'unassigned']?.alternates || []).length}</span>
            </li>
          ))}
        </ul>
      </section>

      {report.recommendation && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Recommendation</h2>
          <p className="text-sm whitespace-pre-wrap">{report.recommendation}</p>
        </section>
      )}
    </main>
  );
}
