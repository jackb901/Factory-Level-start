"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";
// Client-side parsing removed in favor of server-side AI division-level leveling

type Job = { id: string; name: string; created_at: string };
type Bid = { id: string; contractor_id: string | null; division_code: string | null; subdivision_id: string | null; created_at: string };
type Contractor = { id: string; name: string };
type Document = { id: string; bid_id: string; storage_path: string; file_type: string; created_at: string };
type Division = { code: string; name: string };
type SubDivision = { id: string; parent_code: string; name: string; created_at: string };

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
  const [runningLevelStart, setRunningLevelStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [divisionCode, setDivisionCode] = useState<string>("");
  const [subDivisions, setSubDivisions] = useState<Record<string, SubDivision[]>>({});
  const [selectedSubdivisionId, setSelectedSubdivisionId] = useState<string | null>(null);
  const [creatingSubFor, setCreatingSubFor] = useState<string | null>(null);
  const [, setNewSubName] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [subInputFor, setSubInputFor] = useState<string | null>(null);
  // Reset selected bid if it doesn't belong to the selected node
  useEffect(() => {
    if (!divisionCode && !selectedSubdivisionId) { setSelectedBidId(null); return; }
    if (selectedBidId) {
      const b = bids.find(x => x.id === selectedBidId);
      if (!b) { setSelectedBidId(null); return; }
      if (selectedSubdivisionId) {
        if (b.subdivision_id !== selectedSubdivisionId) setSelectedBidId(null);
      } else if (divisionCode) {
        if (b.division_code !== divisionCode || b.subdivision_id) setSelectedBidId(null);
      }
    }
  }, [divisionCode, selectedSubdivisionId, bids, selectedBidId]);

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
      const { data: bidsData } = await supabase
        .from("bids").select("id,contractor_id,division_code,subdivision_id,created_at")
        .eq("job_id", id).order("created_at", { ascending: false });
      setBids(bidsData || []);
      const { data: divs } = await supabase.from("csi_divisions").select("code,name").order("code");
      setDivisions(divs || []);
      const { data: subs } = await supabase
        .from("job_subdivisions").select("id,parent_code,name,created_at").eq("job_id", id).order("created_at", { ascending: true });
      const map: Record<string, SubDivision[]> = {};
      (subs || []).forEach((s: SubDivision) => {
        const arr = map[s.parent_code] || [];
        arr.push(s);
        map[s.parent_code] = arr;
      });
      setSubDivisions(map);
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
      if (!divisionCode && !selectedSubdivisionId) { setDocs([]); return; }
      let bidQuery = supabase.from("bids").select("id").eq("job_id", id);
      if (selectedSubdivisionId) {
        bidQuery = bidQuery.eq("subdivision_id", selectedSubdivisionId);
      } else if (divisionCode) {
        bidQuery = bidQuery.eq("division_code", divisionCode).is("subdivision_id", null);
      }
      const { data: bidRows } = await bidQuery;
      const ids = (bidRows || []).map((b: { id: string }) => b.id);
      if (!ids.length) { setDocs([]); return; }
      const { data } = await supabase
        .from("documents")
        .select("id,bid_id,storage_path,file_type,created_at")
        .in("bid_id", ids)
        .order("created_at", { ascending: false });
      setDocs(data || []);
    })();
  }, [divisionCode, selectedSubdivisionId, id, supabase]);

  const createBid = async () => {
    setCreating(true); setError(null);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { window.location.href = "/login"; return; }
    if (!divisionCode && !selectedSubdivisionId) { setError('Select a CSI division first'); setCreating(false); return; }
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
    const payload: Record<string, unknown> = {
      job_id: id,
      user_id: userData.user.id,
      contractor_id: contractorId,
      division_code: divisionCode || null,
      subdivision_id: selectedSubdivisionId || null,
    };
    const { data: bid, error: bidErr } = await supabase.from("bids").insert(payload).select().single();
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
      const selectedBid = bids.find(b => b.id === selectedBidId);
      let prefix: string;
      if (selectedBid?.contractor_id) {
        const contractorName = contractors[selectedBid.contractor_id]?.name || "Contractor";
        prefix = contractorName.replace(/[^a-zA-Z0-9_.-]+/g, "_");
      } else {
        const base = file.name.replace(/\.[^/.]+$/, "");
        prefix = (base.slice(0, 10) || "file").replace(/[^a-zA-Z0-9_.-]+/g, "_");
      }
      const safeTail = file.name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
      const safeName = `${prefix} ${safeTail}`;
      const divPart = selectedBid?.division_code ? `div-${selectedBid.division_code}/` : "";
      const path = `users/${uid}/jobs/${id}/${divPart}bids/${selectedBidId}/${Date.now()}-${safeName}`;
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
    if (divisionCode) {
      const { data: bidRows } = await supabase
        .from("bids")
        .select("id")
        .eq("job_id", id)
        .eq("division_code", divisionCode);
      const ids = (bidRows || []).map((b: { id: string }) => b.id);
      if (ids.length) {
        const { data } = await supabase
          .from("documents")
          .select("id,bid_id,storage_path,file_type,created_at")
          .in("bid_id", ids)
          .order("created_at", { ascending: false });
        setDocs(data || []);
      } else {
        setDocs([]);
      }
    }
    setUploading(false);
  };

  // Client-side per-document processing removed in favor of division-level AI leveling

  const contractorLabel = (bid: Bid) => bid.contractor_id ? contractors[bid.contractor_id!]?.name || "Contractor" : "(No contractor)";
  const divisionLabel = (code: string | null) => {
    if (!code) return "No division";
    const d = divisions.find(x => x.code === code);
    return d ? `Div ${d.code} - ${d.name}` : `Div ${code}`;
  };

  // Title is rendered inline to allow linking "Job" back to dashboard

  return (
    <main className="min-h-dvh flex bg-[#0a2540] text-white">
      <aside className="w-64 bg-black text-white p-4 space-y-3 hidden sm:block">
        <h2 className="text-sm font-semibold uppercase tracking-wide">CSI Division</h2>
        <ul className="space-y-1 max-h-[80vh] overflow-auto pr-1">
          {divisions.map(d => {
            const subs = subDivisions[d.code] || [];
            const isCollapsed = !!collapsed[d.code];
            return (
              <li key={d.code} className="group">
                <div className="flex items-center gap-2">
                  {subs.length > 0 && (
                    <button
                      aria-label="toggle"
                      className="text-xs opacity-80 hover:opacity-100"
                      onClick={() => setCollapsed(prev => ({...prev, [d.code]: !prev[d.code]}))}
                    >{isCollapsed ? '▶' : '▼'}</button>
                  )}
                  <button
                    className={`flex-1 text-left px-2 py-1 rounded ${divisionCode===d.code && !selectedSubdivisionId? 'bg-white text-black':'hover:bg-white/10'}`}
                    onClick={() => { setDivisionCode(d.code); setSelectedSubdivisionId(null); }}
                  >{`Div ${d.code} — ${d.name}`}</button>
                  <div className="relative">
                    <button className="px-1 py-1 rounded hover:bg-white/10 hidden group-hover:block" aria-label="menu" onClick={() => setCreatingSubFor(p => p===d.code ? null : d.code)}>⋮</button>
                    {creatingSubFor === d.code && (
                      <div className="absolute right-0 mt-1 bg-white text-black rounded shadow">
                        <button className="px-3 py-1 hover:bg-gray-100 w-full text-left" onClick={() => {
                          setCollapsed(prev => ({...prev, [d.code]: false}));
                          setCreatingSubFor(null);
                          setSelectedSubdivisionId(null);
                          setNewSubName("");
                          setSubInputFor(d.code);
                        }}>Create sub division</button>
                      </div>
                    )}
                  </div>
                </div>
                {!isCollapsed && (
                  <ul className="ml-5 mt-1 space-y-1">
                    {/* inline input for new sub division */}
                    {subInputFor === d.code && (
                      <li>
                        <input
                          autoFocus
                          className="w-11/12 px-2 py-1 rounded border bg-white text-black"
                          placeholder="Sub division name"
                          onBlur={() => { setSubInputFor(null); setNewSubName(""); }}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') {
                              const name = (e.target as HTMLInputElement).value.trim();
                              if (!name) { setSubInputFor(null); setNewSubName(""); return; }
                              const { data: userData } = await supabase.auth.getUser();
                              if (!userData.user) { window.location.href = '/login'; return; }
                              const { data, error } = await supabase.from('job_subdivisions').insert({
                                user_id: userData.user.id,
                                job_id: id,
                                parent_code: d.code,
                                name,
                              }).select('id,parent_code,name,created_at').single();
                              if (!error && data) {
                                const created = data as SubDivision;
                                setSubDivisions(prev => ({...prev, [d.code]: [...(prev[d.code]||[]), created]}));
                                setCollapsed(prev => ({...prev, [d.code]: false}));
                                setSubInputFor(null);
                                setNewSubName("");
                                setSelectedSubdivisionId(created.id);
                                setDivisionCode(d.code);
                              }
                            }
                          }}
                        />
                      </li>
                    )}
                    {subs.map(s => (
                      <li key={s.id}>
                        <button
                          className={`w-full text-left px-2 py-1 rounded ${selectedSubdivisionId===s.id? 'bg-white text-black':'hover:bg-white/10'}`}
                          onClick={() => { setDivisionCode(s.parent_code); setSelectedSubdivisionId(s.id); }}
                        >{s.name}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="flex-1 p-6 space-y-6">
      {job ? (
        <h1 className="text-2xl font-semibold">
          <a href="/dashboard" className="underline hover:opacity-80">Job</a>: {job.name}
        </h1>
      ) : (
        <h1 className="text-2xl font-semibold">Loading job…</h1>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Create a Bid</h2>
        <div className="flex gap-2 items-center">
          <input className="border rounded px-3 py-2" placeholder="Contractor name (optional)" value={newContractorName} onChange={(e) => setNewContractorName(e.target.value)} />
          <div className="sm:hidden">
            <select className="border rounded px-3 py-2 bg-white text-black" value={divisionCode} onChange={(e) => setDivisionCode(e.target.value)}>
              <option value="">Select division…</option>
              {divisions.map(d => (
                <option key={d.code} value={d.code}>{`Div ${d.code} — ${d.name}`}</option>
              ))}
            </select>
          </div>
          <button className="border rounded px-3 py-2 disabled:opacity-50" onClick={createBid} disabled={creating || !divisionCode}>{creating ? "Creating…" : "Create Bid"}</button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Bids</h2>
        <select className="border rounded px-3 py-2 bg-white text-black" value={selectedBidId || ""} onChange={(e) => setSelectedBidId(e.target.value || null)} disabled={!divisionCode && !selectedSubdivisionId}>
          <option value="">Select a bid…</option>
          {bids.filter(b => selectedSubdivisionId ? b.subdivision_id === selectedSubdivisionId : (b.division_code === divisionCode && !b.subdivision_id)).map(b => (
            <option className="text-black" key={b.id} value={b.id}>
              {new Date(b.created_at).toLocaleString()} — {contractorLabel(b)} — {divisionLabel(b.division_code)}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Upload documents</h2>
        <input type="file" multiple accept=".pdf,.xls,.xlsx,.csv,.doc,.docx,image/*" onChange={(e) => uploadFiles(e.target.files)} disabled={!selectedBidId || uploading} />
        {uploading && <p className="text-sm">Uploading…</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Documents (division bucket)</h2>
        <ul className="space-y-2">
          {docs.map(d => (
            <li key={d.id} className="border rounded p-2 text-sm flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span>{(() => {
                  const bid = bids.find(b => b.id === d.bid_id);
                  if (bid?.contractor_id) {
                    return contractors[bid.contractor_id!]?.name || "Contractor";
                  }
                  const parts = d.storage_path.split("/");
                  const fname = parts[parts.length - 1] || "";
                  const afterDash = fname.includes("-") ? fname.substring(fname.indexOf("-") + 1) : fname;
                  const base = afterDash.replace(/\.[^/.]+$/, "");
                  return base.slice(0, 10);
                })()}</span>
                <span className="text-gray-500">{new Date(d.created_at).toLocaleString()}</span>
              </div>
              {/* Processing removed in favor of AI division-level leveleing */}
            </li>
          ))}
          {!docs.length && <li className="text-sm text-gray-600">No documents uploaded yet.</li>}
        </ul>
        <button
          className="block mx-auto mt-4 w-full sm:w-1/2 rounded-lg bg-neutral-700 text-white px-6 py-3 text-center shadow transition hover:bg-neutral-600 active:translate-y-[1px] active:shadow-inner disabled:opacity-50"
          disabled={!divisionCode || runningLevelStart}
          onClick={async () => {
            if (!divisionCode) return;
            setRunningLevelStart(true); setError(null);
            const { data: session } = await supabase.auth.getSession();
            const token = session.session?.access_token; if (!token) { setError('Missing session'); setRunningLevelStart(false); return; }
            const res = await fetch('/api/ai/level-division', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ jobId: id, division: divisionCode || null, subdivisionId: selectedSubdivisionId || null })
            });
            if (!res.ok) {
              let details = '';
              try {
                const txt = await res.text();
                if (txt) {
                  try {
                    const j = JSON.parse(txt);
                    details = j.error || j.preview || txt;
                  } catch {
                    details = txt;
                  }
                }
              } catch {}
              setError(`LevelStart failed (HTTP ${res.status} ${res.statusText}): ${details}`);
              setRunningLevelStart(false);
              return;
            }
            window.location.href = `/jobs/${id}/division/${divisionCode}/report`;
          }}
        >Run LevelStart</button>
      </section>
      </div>
    </main>
  );
}
