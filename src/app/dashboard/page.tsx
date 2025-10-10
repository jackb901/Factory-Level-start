"use client";
import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";

type Job = { id: string; name: string; created_at: string };

export default function DashboardPage() {
  const supabase = getSupabaseClient();
  const [userName, setUserName] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [newJob, setNewJob] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const t0 = performance.now();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) { window.location.href = "/login"; return; }
      const email = data.user.email || "";
      const meta = data.user.user_metadata as Record<string, unknown> | null | undefined;
      const full = (meta && typeof meta["full_name"] === "string" ? (meta["full_name"] as string) : undefined);
      setUserName(full || (email.split("@")[0] || "User"));
      const { data: js } = await supabase.from("jobs").select("id,name,created_at").order("created_at", { ascending: false });
      setJobs(js || []);
      setLoading(false);
      log("dashboard_loaded", { duration_ms: performance.now() - t0, jobs: js?.length || 0 });
    })();
  }, [supabase]);

  const onCreate = async () => {
    if (!newJob.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { window.location.href = "/login"; return; }
    const { data, error } = await supabase.from("jobs").insert({ user_id: u.user.id, name: newJob.trim() }).select();
    if (!error && data) {
      setJobs((prev) => [data[0] as Job, ...prev]);
      setNewJob("");
    }
  };

  const gridJobs = useMemo(() => jobs, [jobs]);

  if (loading) return <main className="min-h-dvh p-6 bg-[#0a2540] text-white">Loading…</main>;

  return (
    <main className="min-h-dvh bg-[#0a2540] text-white p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{userName}&apos;s Dashboard</h1>
        <button
          className="border rounded px-3 py-1"
          onClick={async () => { await supabase.auth.signOut(); window.location.href = "/"; }}
        >Sign out</button>
      </div>

      <div className="flex items-center gap-2">
        <input
          className="border rounded px-3 py-2 w-72"
          placeholder="New job name"
          value={newJob}
          onChange={(e) => setNewJob(e.target.value)}
        />
        <button className="border rounded px-3 py-2" onClick={onCreate} disabled={!newJob.trim()}>Create Job</button>
      </div>

      <section>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {gridJobs.map((j, idx) => (
            <div
              key={j.id}
              className="border rounded-lg p-4 text-center bg-white text-black cursor-move select-none"
              draggable
              onDragStart={() => setDragIndex(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex === null || dragIndex === idx) return;
                setJobs((prev) => {
                  const copy = [...prev];
                  const [m] = copy.splice(dragIndex, 1);
                  copy.splice(idx, 0, m);
                  return copy;
                });
                setDragIndex(null);
              }}
            >
              <div className="text-lg font-medium break-words min-h-[3rem] flex items-center justify-center">{j.name}</div>
              <div className="mt-3">
                <a className="underline" href={`/jobs/${j.id}`}>Open</a>
              </div>
            </div>
          ))}
          {!gridJobs.length && <div className="text-sm text-gray-600">No jobs yet. Create one above.</div>}
        </div>
      </section>
    </main>
  );
}
