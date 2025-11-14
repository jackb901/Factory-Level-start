"use client";
import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";
import Link from "next/link";

type Job = { id: string; name: string; created_at: string };

export default function JobsPage() {
  const supabase = getSupabaseClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const t0 = performance.now();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        window.location.href = "/login";
        return;
      }
      // Ensure profile row exists (best-effort)
      await supabase.from("profiles").upsert({ id: userData.user.id, email: userData.user.email });
      const { data, error } = await supabase
        .from("jobs")
        .select("id,name,created_at")
        .order("created_at", { ascending: false });
      if (error) setError(error.message);
      setJobs(data || []);
      setLoading(false);
      log("jobs_loaded", { duration_ms: performance.now() - t0, count: data?.length || 0 });
    })();
  }, [supabase]);

  const createJob = async () => {
    setError(null);
    const t0 = performance.now();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      window.location.href = "/login";
      return;
    }
    const { data, error } = await supabase.from("jobs").insert({ user_id: userData.user.id, name }).select();
    if (error) {
      setError(error.message);
      log("job_create_error", { message: error.message }, "error");
      return;
    }
    log("job_created", { duration_ms: performance.now() - t0 });
    setName("");
    setJobs((prev) => (data ? [...data, ...prev] : prev));
  };

  const deleteJob = async (id: string) => {
    setError(null);
    if (!confirm('Delete this job and its data? This cannot be undone.')) return;
    const { error } = await supabase.from('jobs').delete().eq('id', id);
    if (error) { setError(error.message); return; }
    setJobs(prev => prev.filter(j => j.id !== id));
    setMenuOpenId(null);
  };

  if (loading) return <p className="p-6">Loading…</p>;

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Jobs</h1>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Job name"
          className="border rounded px-3 py-2 w-80"
        />
        <button className="border rounded px-4 py-2" onClick={createJob} disabled={!name.trim()}>
          Create Job
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {jobs.map((j) => (
          <li key={j.id} className="relative border rounded bg-white text-black">
            <button
              aria-label="Job menu"
              className="absolute right-2 top-2 px-2 py-1 text-lg leading-none text-black hover:bg-black/5 rounded"
              onClick={() => setMenuOpenId(prev => prev === j.id ? null : j.id)}
            >
              ...
            </button>
            {menuOpenId === j.id && (
              <div className="absolute right-2 top-8 z-10 w-32 rounded border bg-white shadow">
                <button
                  className="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600"
                  onClick={() => deleteJob(j.id)}
                >
                  Delete
                </button>
              </div>
            )}
            <div className="p-4">
              <div className="font-medium">{j.name}</div>
              <div className="text-xs text-gray-500">{new Date(j.created_at).toLocaleString()}</div>
              <div className="mt-2">
                <Link className="underline" href={`/jobs/${j.id}`} onClick={() => setMenuOpenId(null)}>Open</Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
