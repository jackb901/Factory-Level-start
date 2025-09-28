"use client";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useEffect, useState } from "react";

export default function LoginPage() {
  const supabase = getSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If already logged in, redirect to dashboard
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.href = "/dashboard";
    });
  }, [supabase]);

  const signIn = async () => {
    setLoading(true);
    setError(null);
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL || window.location.origin}/dashboard`;
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-sm border rounded-lg p-6 space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <button
          className="w-full border rounded px-4 py-2 hover:bg-gray-50 disabled:opacity-50"
          onClick={signIn}
          disabled={loading}
        >
          Continue with Google
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </main>
  );
}
