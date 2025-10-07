import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { parseFile } from "@/lib/parse";
import { levelItem } from "@/lib/level";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { bidId } = await req.json().catch(() => ({}));
    if (!bidId) return new Response(JSON.stringify({ error: "Missing bidId" }), { status: 400 });

    const auth = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!auth) return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabase = createClient(supabaseUrl, supabaseAnon, { global: { headers: { Authorization: auth } } });

    const { data: bid, error: bidErr } = await supabase.from("bids").select("id, user_id, division_code, job_id").eq("id", bidId).single();
    if (bidErr || !bid) return new Response(JSON.stringify({ error: bidErr?.message || "Bid not found" }), { status: 404 });

    const { data: docs } = await supabase.from("documents").select("id, storage_path, file_type, created_at").eq("bid_id", bidId).order("created_at");
    if (!docs || !docs.length) return new Response(JSON.stringify({ error: "No documents for this bid." }), { status: 400 });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return new Response(JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY" }), { status: 500 });
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Collect items from all docs
    let extracted: Array<{ raw_text: string; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null }> = [];
    for (const d of docs) {
      const { data: blob, error } = await supabase.storage.from("bids").download(d.storage_path);
      if (error || !blob) continue;
      const items = await parseFile(blob, d.storage_path);
      for (const it of items) {
        extracted.push({ raw_text: it.raw_text, qty: it.qty, unit: it.unit, unit_cost: it.unit_cost, total: it.total });
        if (extracted.length >= 1200) break; // cap to control tokens
      }
      if (extracted.length >= 1200) break;
    }

    if (!extracted.length) return new Response(JSON.stringify({ error: "No parsable content found." }), { status: 400 });

    const examples = extracted.slice(0, 200).map((e) => ({ description: e.raw_text, qty: e.qty, unit: e.unit, unit_cost: e.unit_cost, total: e.total }));

    const system = `You are a construction bid leveling assistant. Normalize items into a consistent schema, map to canonical names, and detect inclusions/exclusions/allowances/alternates. Output strict JSON only.`;
    const user = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Input items (sample):\n${JSON.stringify(examples).slice(0, 20000)}\n\nDesired JSON format:\n{ "items": [{"canonical_name": string | null, "raw_text": string, "qty": number | null, "unit": string | null, "unit_cost": number | null, "total": number | null}], "summary": {"includes": string[], "excludes": string[], "allowances": string[], "alternates": string[] } }`,
        },
      ],
    } as const;

    const resp = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 4000,
      temperature: 0.2,
      system,
      messages: [user],
    });

    const content = resp.content?.[0] && (resp.content[0] as any).type === "text" ? (resp.content[0] as any).text : "{}";
    let parsed: any;
    try { parsed = JSON.parse(content as string); } catch {
      return new Response(JSON.stringify({ error: "AI output was not valid JSON" }), { status: 502 });
    }
    const aiItems: Array<{ raw_text: string; canonical_name: string | null; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null }> = parsed.items || [];
    const summary = parsed.summary || { includes: [], excludes: [], allowances: [], alternates: [] };

    // Replace existing items for this bid (owned by the user)
    await supabase.from("line_items").delete().eq("bid_id", bidId);

    const chunkSize = 200;
    for (let i = 0; i < aiItems.length; i += chunkSize) {
      const chunk = aiItems.slice(i, i + chunkSize).map((it: any) => {
        const out = levelItem({ raw_text: it.raw_text, qty: it.qty, unit: it.unit, unit_cost: it.unit_cost, total: it.total });
        const sanitize = (s: string | null): string | null => s == null ? s : s.replace(/[\u0000-\u001F]/g, '').slice(0, 5000);
        return {
          user_id: bid.user_id,
          bid_id: bidId,
          category_id: null,
          raw_text: sanitize(it.raw_text)!,
          canonical_name: sanitize(out.canonical_name),
          qty: out.qty,
          unit: sanitize(out.unit),
          unit_cost: out.unit_cost,
          total: out.total,
          confidence: 1.0,
        };
      });
      const { error } = await supabase.from("line_items").insert(chunk);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }

    const counts = {
      includes_count: (summary.includes || []).length,
      excludes_count: (summary.excludes || []).length,
      allowances_count: (summary.allowances || []).length,
      alternates_count: (summary.alternates || []).length,
    };
    await supabase.from("bid_analyses").insert({ user_id: bid.user_id, bid_id: bidId, division_code: bid.division_code, summary, ...counts });

    return new Response(JSON.stringify({ ok: true, items: aiItems.length, summary: counts }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Unknown error" }), { status: 500 });
  }
}
