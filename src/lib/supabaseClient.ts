"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseClient() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Minimal runtime warning; avoid throwing to keep UI renderable.
    console.warn("Supabase env not set: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY");
  }
  client = createClient(url || "", anon || "");
  return client;
}
