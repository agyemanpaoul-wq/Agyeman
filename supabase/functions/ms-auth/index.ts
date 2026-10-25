// Edge Function "ms-auth": collega l'account Microsoft 365 (una volta sola).
// DEPLOY CON "Verify JWT" DISATTIVATO: Microsoft richiama questa URL senza token Supabase.
// GET ?action=start (con header Authorization dell'utente) -> restituisce l'URL di login Microsoft.
// GET ?code=...&state=... (callback Microsoft) -> salva il refresh token e torna all'app.
// Secret: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, APP_URL.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const SCOPES = "offline_access User.Read Mail.Read Calendars.ReadWrite Tasks.ReadWrite";
const env = (k: string) => Deno.env.get(k)!;
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const redirectUri = () => `${env("SUPABASE_URL")}/functions/v1/ms-auth`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  if (url.searchParams.get("action") === "start") {
    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } } });
    const { data: owner } = await supa.rpc("is_owner");
    if (owner !== true) return new Response(JSON.stringify({ error: "Non autorizzato" }), { status: 401, headers: CORS });
    const state = crypto.randomUUID();
    await admin().from("ms_oauth_state").insert({ state });
    const login = new URL(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/authorize`);
    login.search = new URLSearchParams({ client_id: env("MS_CLIENT_ID"), response_type: "code", redirect_uri: redirectUri(),
      response_mode: "query", scope: SCOPES, state }).toString();
    return new Response(JSON.stringify({ url: login.toString() }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state) return new Response("Richiesta non valida", { status: 400 });
  const db = admin();
  const { data: st } = await db.from("ms_oauth_state").delete().eq("state", state).select();
  if (!st || !st.length) return new Response("Stato non valido o scaduto", { status: 400 });

  const res = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "authorization_code",
      code, redirect_uri: redirectUri(), scope: SCOPES }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.refresh_token) return new Response("Collegamento non riuscito: " + (tok.error_description ?? res.status), { status: 502 });
  await db.from("ms_tokens").upsert({ id: 1, refresh_token: tok.refresh_token, updated_at: new Date().toISOString() });
  return Response.redirect(`${env("APP_URL")}#agenda`, 302);
});
