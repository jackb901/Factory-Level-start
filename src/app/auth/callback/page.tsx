"use client";
import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { log } from "@/lib/logger";

export default function AuthCallbackPage() {
  const supabase = getSupabaseClient();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        }
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          window.location.replace("/dashboard");
          return;
        }
        setMsg("No session found. Redirecting to login…");
        window.location.replace("/login");
      } catch (e) {
        log("auth_callback_error", { message: (e as Error).message }, "error");
        setMsg("Sign-in failed. Redirecting to login…");
        setTimeout(() => window.location.replace("/login"), 1000);
      }
    })();
  }, [supabase]);

  return <main className="p-6">{msg}</main>;
}
