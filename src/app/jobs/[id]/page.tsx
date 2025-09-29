"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";

type Job = { id: string; name: string; created_at: string };
type Bid = { id: string; contractor_id: string | null; created_at: string };
type Contractor = { id: string; name: string };
type Document = { id: string; storage_path: string; file_type: string; created_at: string };

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = getSupabaseClient();
  const [job, setJob] = useState<Job | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [contractors, setContractors] = useState<Record<string, Contractor>>({});
  const [selectedBidId, setSelectedBidId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [newContractorName, setNewContractorName] = useState("");
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const t0 = performance.now();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        window.location.href = "/login";
        return;
      }
      const { data: jobData, error: jobErr } = await supabase.from("jobs").select("id,name,created_at").eq("id", id).single();
      if (jobErr) { setError(jobErr.message); return; }
      setJob(jobData as Job);
      const { data: bidsData } = await supabase.from("bids").select("id,contractor_id,created_at").eq("job_id", id).order("created_at", { ascending: false });
      setBids(bidsData || []);
      if (bidsData && bidsData.length) {
        const contractorIds = bidsData.map(b => b.contractor_id).filter(Boolean) as string[];
        if (contractorIds.length) {
          const { data: cons } = await supabase.from("contractors").select("id,name").in("id", contractorIds);
          const map: Record<string, Contractor> = {};
          cons?.forEach(c => { map[c.id] = c; });
          setContractors(map);
        }
      }
      log("job_detail_loaded", { job_id: id, duration_ms: performance.now() - t0 });
    })();
  }, [id, supabase]);

  useEffect(() => {
    (async () => {
      if (!selectedBidId) { setDocs([]); return; }
      const { data } = await supabase.from("documents").select("id,storage_path,file_type,created_at").eq("bid_id", selectedBidId).order("created_at", { ascending: false });
      setDocs(data || []);
    })();
  }, [selectedBidId, supabase]);

  const createBid = async () => {
    setCreating(true); setError(null);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { window.location.href = "/login"; return; }
    let contractorId: string | null = null;
    if (newContractorName.trim()) {
      const { data: cons, error } = await supabase
        .from("contractors")
        .insert({ job_id: id, user_id: userData.user.id, name: newContractorName.trim() })
        .select("id,name")
        .single();
      if (error) { setError(error.message); setCreating(false); return; }
      contractorId = (cons as Contractor).id;
      setContractors((prev) => ({ ...(prev || {}), [(cons as Contractor).id]: cons as Contractor }));
    }
    const { data: bid, error: bidErr } = await supabase.from("bids").insert({
      job_id: id,
      user_id: userData.user.id,
      contractor_id: contractorId
    }).select().single();
    if (bidErr) { setError(bidErr.message); setCreating(false); return; }
    setBids(prev => [bid as Bid, ...prev]);
    setSelectedBidId((bid as Bid).id);
    setNewContractorName("");
    setCreating(false);
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || !selectedBidId) return;
    setUploading(true); setError(null);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { window.location.href = "/login"; return; }
    const uid = userData.user.id;
    for (const file of Array.from(files)) {
      if (file.size > 25 * 1024 * 1024) { setError(`File too large: ${file.name}`); continue; }
      const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const path = `users/${uid}/jobs/${id}/bids/${selectedBidId}/${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from("bids").upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
      if (upErr) { setError(upErr.message); continue; }
      const fileType = file.type || "application/octet-stream";
      const { error: insErr } = await supabase.from("documents").insert({
        bid_id: selectedBidId,
        user_id: uid,
        file_type: fileType,
        storage_path: path,
      });
      if (insErr) { setError(insErr.message); }
    }
    // Refresh docs list
    const { data } = await supabase.from("documents").select("id,storage_path,file_type,created_at").eq("bid_id", selectedBidId).order("created_at", { ascending: false });
    setDocs(data || []);
    setUploading(false);
  };

  const contractorLabel = (bid: Bid) => bid.contractor_id ? contractors[bid.contractor_id!]?.name || "Contractor" : "(No contractor)";

  const title = useMemo(() => job ? `Job: ${job.name}` : "Loading job…", [job]);

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Create a Bid</h2>
        <div className="flex gap-2 items-center">
          <input className="border rounded px-3 py-2" placeholder="Contractor name (optional)" value={newContractorName} onChange={(e) => setNewContractorName(e.target.value)} />
          <button className="border rounded px-3 py-2" onClick={createBid} disabled={creating}>{creating ? "Creating…" : "Create Bid"}</button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Bids</h2>
        <select className="border rounded px-3 py-2 bg-white text-black" value={selectedBidId || ""} onChange={(e) => setSelectedBidId(e.target.value || null)}>
          <option value="">Select a bid…</option>
          {bids.map(b => (
            <option className="text-black" key={b.id} value={b.id}>{new Date(b.created_at).toLocaleString()} — {contractorLabel(b)}</option>
          ))}
        </select>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Upload documents</h2>
        <input type="file" multiple accept=".pdf,.xls,.xlsx,.csv,.doc,.docx,image/*" onChange={(e) => uploadFiles(e.target.files)} disabled={!selectedBidId || uploading} />
        {uploading && <p className="text-sm">Uploading…</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Documents</h2>
        <ul className="space-y-2">
          {docs.map(d => (
            <li key={d.id} className="border rounded p-2 text-sm flex justify-between">
              <span>{d.file_type}</span>
              <span className="text-gray-500">{new Date(d.created_at).toLocaleString()}</span>
            </li>
          ))}
          {!docs.length && <li className="text-sm text-gray-600">No documents uploaded yet.</li>}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Processing (demo)</h2>
        <button
          className="border rounded px-3 py-2"
          onClick={() => {
            const es = new EventSource(`/api/progress?jobId=${id}`);
            es.onmessage = (e) => {
              try { const data = JSON.parse(e.data); console.log("progress", data); } catch {}
              if (e.data.includes('done')) es.close();
            };
            es.onerror = () => es.close();
          }}
        >Start Demo Progress</button>
        <p className="text-xs text-gray-600">Opens an SSE stream and logs progress to the console.</p>
      </section>
    </main>
  );
}
