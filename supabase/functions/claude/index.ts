// Edge Function "claude": passaggio sicuro verso l'API di Anthropic per coach, briefing, pasti da foto,
// lettura avvisi pagoPA e inserimento in linguaggio naturale. La chiave API resta qui.
// Verify JWT ATTIVO. Body: {messages, system?, tools?, tier?: "quick"|"default", max_tokens?}
// Secret: ANTHROPIC_API_KEY. Opzionali: CLAUDE_MODEL, CLAUDE_MODEL_QUICK.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: owner } = await supa.rpc("is_owner");
    if (owner !== true) return json({ error: "Non autorizzato" }, 401);

    const { messages, system, tools, tier, max_tokens } = await req.json();
    if (!Array.isArray(messages) || !messages.length) return json({ error: "Messaggi mancanti" }, 400);
    const model = tier === "quick" ? (Deno.env.get("CLAUDE_MODEL_QUICK") ?? "claude-haiku-5-5") : (Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: Math.min(max_tokens ?? 2000, 4000), messages, ...(system ? { system } : {}), ...(tools?.length ? { tools } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message ?? "Errore API Claude", status: res.status }, res.status === 429 ? 429 : 502);
    return json({ content: data.content, stop_reason: data.stop_reason, usage: data.usage });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
