"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";

export default function DashboardPage() {
  const supabase = getSupabaseClient();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const started = performance.now();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) {
        log("auth_missing", { stage: "dashboard", duration_ms: performance.now() - started, error: error?.message }, "warn");
        window.location.href = "/login";
        return;
      }
      setEmail(data.user.email ?? null);
      setLoading(false);
      log("dashboard_loaded", { duration_ms: performance.now() - started });
    })();
  }, [supabase]);

  if (loading) return <p className="p-6">Loading…</p>;

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p>Signed in as {email}</p>
      <div className="space-x-2">
        <Link className="underline" href="/">Home</Link>
        <button
          className="border rounded px-3 py-1"
          onClick={async () => {
            const started = performance.now();
            await supabase.auth.signOut();
            log("signout", { duration_ms: performance.now() - started });
            window.location.href = "/";
          }}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
