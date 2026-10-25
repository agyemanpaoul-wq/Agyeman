// Edge Function "ms-sync": legge posta e calendario Outlook, classifica le email nuove con Claude,
// registra le bollette trovate. Chiamata ogni 30 minuti da GitHub Actions.
// DEPLOY CON "Verify JWT" DISATTIVATO: l'accesso è protetto dall'header x-sync-token.
// Secret: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, SYNC_TOKEN, ANTHROPIC_API_KEY, CLAUDE_MODEL (opz.).
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k)!;
const SCOPES = "offline_access User.Read Mail.Read Calendars.ReadWrite Tasks.ReadWrite";
const TZ = "Europe/Rome";
// Classificazione Work/Life degli appuntamenti Outlook: parole chiave private, il resto è lavoro.
const LIFE_RE = /(allenament|corsa|palestra|trainer|hyrox|famiglia|cena|compleann|medic|pediatr|dentist|asilo|scuola|personal|privat|vacanz|ferie|fisioterap)/i;
const areaOf = (s: string) => (LIFE_RE.test(s) ? "life" : "work");

async function accessToken(db: ReturnType<typeof createClient>) {
  const { data } = await db.from("ms_tokens").select("refresh_token").eq("id", 1).single();
  if (!data) throw new Error("Outlook non collegato");
  const res = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"),
      grant_type: "refresh_token", refresh_token: data.refresh_token, scope: SCOPES }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error("Token Microsoft: " + (tok.error_description ?? res.status));
  if (tok.refresh_token) await db.from("ms_tokens").update({ refresh_token: tok.refresh_token, updated_at: new Date().toISOString() }).eq("id", 1);
  return tok.access_token as string;
}

async function graph(token: string, path: string, prefer = "") {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...(prefer ? { Prefer: prefer } : {}) },
  });
  if (!res.ok) throw new Error(`Graph ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function triage(mails: { id: string; from: string; subject: string; received: string; body: string }[]) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const list = mails.map((m) => `ID ${m.id}\nda: ${m.from}\noggetto: ${m.subject}\nricevuta: ${m.received}\n${m.body.slice(0, 3000)}`).join("\n\n---\n\n");
  const prompt = `Oggi è ${today}. Sei l'assistente di un ingegnere consulente di finanza agevolata.
Per ogni email: priorità (alta se cliente o ente con scadenza, media se richiede un'azione non urgente, bassa se informativa o promozionale),
sintesi in una frase, azioni concrete. Azioni possibili:
{"type":"task","title":"...","date":"YYYY-MM-DD"} | {"type":"event","title":"...","date":"YYYY-MM-DD","time":"HH:MM"} |
{"type":"bill","title":"fornitore","date":"YYYY-MM-DD","amount":0,"notice_code":"codice avviso pagoPA di 18 cifre senza spazi o null","ente_cf":"codice fiscale ente creditore o null","method":"se non pagoPA: come si paga, o null","direct_debit":false}.
Indica notice_code solo se nel testo compare esplicitamente un avviso pagoPA: non inventarlo.
Usa "bill" solo per bollette o avvisi di pagamento personali o aziendali con importo e scadenza. Converti scadenze relative in date assolute.
Rispondi SOLO con JSON: [{"id":"...","prio":"alta|media|bassa","summary":"...","actions":[...]}]

${list}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Claude: " + (data?.error?.message ?? res.status));
  const raw = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean.slice(clean.indexOf("["), clean.lastIndexOf("]") + 1));
}

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-token") !== env("SYNC_TOKEN")) return new Response("Non autorizzato", { status: 401 });
  try {
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const token = await accessToken(db);

    // 1. Posta: ultime 48 ore della Posta in arrivo, solo messaggi non ancora analizzati (max 20 per giro)
    const since = new Date(Date.now() - 48 * 3600e3).toISOString();
    const inbox = await graph(token, `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=50&$select=id,subject,from,receivedDateTime,bodyPreview,body`,
      'outlook.body-content-type="text"');
    const msgs = inbox.value ?? [];
    const { data: known } = await db.from("emails").select("id").in("id", msgs.map((m: { id: string }) => m.id));
    const knownIds = new Set((known ?? []).map((k: { id: string }) => k.id));
    const fresh = msgs.filter((m: { id: string }) => !knownIds.has(m.id)).slice(0, 20);

    let triaged = 0;
    if (fresh.length) {
      const input = fresh.map((m: any) => ({ id: m.id, from: `${m.from?.emailAddress?.name ?? ""} <${m.from?.emailAddress?.address ?? ""}>`,
        subject: m.subject ?? "", received: m.receivedDateTime, body: m.body?.content ?? m.bodyPreview ?? "" }));
      const out = await triage(input);
      const byId = new Map(out.map((o: any) => [o.id, o]));
      const rows = fresh.map((m: any) => {
        const t: any = byId.get(m.id) ?? { prio: "media", summary: m.bodyPreview?.slice(0, 160) ?? "", actions: [] };
        return { id: m.id, received_at: m.receivedDateTime, from_name: m.from?.emailAddress?.name, from_addr: m.from?.emailAddress?.address,
          subject: m.subject, preview: m.bodyPreview, prio: t.prio, summary: t.summary, actions: t.actions ?? [] };
      });
      await db.from("emails").upsert(rows);
      triaged = rows.length;
      // bollette: registrate subito, una per email
      const bills = rows.flatMap((r: any) => (r.actions as any[]).filter((a) => a.type === "bill" && a.date).map((a) => ({
        vendor: a.title, amount: a.amount ?? null, due: a.date, status: a.direct_debit ? "domiciliata" : "da pagare", notice_code: a.notice_code ? String(a.notice_code).replace(/\D/g, "") : null,
        ente_cf: a.ente_cf ?? null, method: a.method ?? null, email_id: r.id })));
      if (bills.length) await db.from("bills").upsert(bills, { onConflict: "email_id", ignoreDuplicates: true });
    }

    // 2. Calendario: da ieri ai prossimi 30 giorni (sostituisce le righe Outlook)
    const start = new Date(Date.now() - 864e5).toISOString(), end = new Date(Date.now() + 30 * 864e5).toISOString();
    const cal = await graph(token, `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$select=id,subject,start,end,location,isAllDay`,
      `outlook.timezone="UTC"`);
    const evRows = (cal.value ?? []).map((e: any) => ({ id: e.id, subject: e.subject, start_at: e.start.dateTime + "Z", end_at: e.end.dateTime + "Z",
      location: e.location?.displayName ?? "", all_day: e.isAllDay, area: areaOf(e.subject ?? ""), src: "Outlook" }));
    await db.from("events").delete().eq("src", "Outlook");
    if (evRows.length) await db.from("events").insert(evRows);

    return new Response(JSON.stringify({ ok: true, email_nuove: triaged, appuntamenti: evRows.length }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
