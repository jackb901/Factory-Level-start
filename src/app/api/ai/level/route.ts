import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { levelItem } from "@/lib/level";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

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

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return new Response(JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY" }), { status: 500 });
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Collect existing parsed items (require user to Process first for PDFs/CSVs/XLSX)
    type DBItem = { raw_text: string | null; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null };
    const { data: existingItems } = await supabase
      .from("line_items")
      .select("raw_text, qty, unit, unit_cost, total")
      .eq("bid_id", bidId)
      .limit(2000);
    const extracted: Array<{ raw_text: string; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null }> = (existingItems as DBItem[] | null || []).map((it: DBItem) => ({
      raw_text: it.raw_text ?? '',
      qty: it.qty,
      unit: it.unit,
      unit_cost: it.unit_cost,
      total: it.total,
    }));

    if (!extracted.length) return new Response(JSON.stringify({ error: "No items to analyze. Click Process first, then try AI Level." }), { status: 400 });

    const examples = extracted.slice(0, 200).map((e) => ({ description: e.raw_text, qty: e.qty, unit: e.unit, unit_cost: e.unit_cost, total: e.total }));

    const system = `You are a construction bid leveling assistant. Normalize items into a consistent schema, map to canonical names, and detect inclusions/exclusions/allowances/alternates. Output strict JSON only.`;
    const userMsg: { role: "user"; content: { type: "text"; text: string }[] } = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Input items (sample):\n${JSON.stringify(examples).slice(0, 20000)}\n\nDesired JSON format:\n{ "items": [{"canonical_name": string | null, "raw_text": string, "qty": number | null, "unit": string | null, "unit_cost": number | null, "total": number | null}], "summary": {"includes": string[], "excludes": string[], "allowances": string[], "alternates": string[] } }`,
        },
      ],
    };

    const resp = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 4000,
      temperature: 0.2,
      system,
      messages: [userMsg],
    });

    // Extract the first text block safely
    const textBlock = Array.isArray(resp.content)
      ? (resp.content.find((b: unknown) => {
          if (typeof b !== 'object' || b === null) return false;
          const r = b as Record<string, unknown>;
          return r['type'] === 'text' && typeof r['text'] === 'string';
        }) as { type: string; text?: string } | undefined)
      : undefined;
    const content = textBlock?.text ?? "{}";

    type AIItem = { raw_text: string; canonical_name: string | null; qty: number | null; unit: string | null; unit_cost: number | null; total: number | null };
    type AISummary = { includes: string[]; excludes: string[]; allowances: string[]; alternates: string[] };
    type AIResponse = { items?: AIItem[]; summary?: AISummary };

    let parsed: AIResponse;
    try { parsed = JSON.parse(content) as AIResponse; } catch {
      return new Response(JSON.stringify({ error: "AI output was not valid JSON" }), { status: 502 });
    }
    const aiItems: AIItem[] = parsed.items || [];
    const summary: AISummary = parsed.summary || { includes: [], excludes: [], allowances: [], alternates: [] };

    // Replace existing items for this bid (owned by the user)
    await supabase.from("line_items").delete().eq("bid_id", bidId);

    const chunkSize = 200;
    for (let i = 0; i < aiItems.length; i += chunkSize) {
      const chunk = aiItems.slice(i, i + chunkSize).map((it) => {
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
