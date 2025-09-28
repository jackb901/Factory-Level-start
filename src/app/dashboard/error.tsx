"use client";
import { useEffect } from "react";
import { log } from "@/lib/logger";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    log("dashboard_error", { message: error.message, digest: error.digest }, "error");
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-gray-600">Try again, or go back to Login.</p>
      <div className="space-x-2">
        <button className="border rounded px-3 py-1" onClick={() => reset()}>Try again</button>
        <a className="underline" href="/login">Back to Login</a>
      </div>
    </main>
  );
}
