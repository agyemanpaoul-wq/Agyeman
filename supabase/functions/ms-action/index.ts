// Edge Function "ms-action": crea task (Microsoft To Do) e appuntamenti (calendario Outlook) dall'app.
// Le notifiche arrivano sull'iPhone tramite le app To Do e Outlook / Calendario.
// Verify JWT ATTIVO. Body: {action:"create_task", title, due?, time?, area?} | {action:"create_event", title, date, time, duration_min?, location?, area?}
//                         | {action:"complete_task", id}
// Secret: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k)!;
const SCOPES = "offline_access User.Read Mail.Read Calendars.ReadWrite Tasks.ReadWrite";
const TZ = "W. Europe Standard Time"; // fuso Windows usato da Graph per Roma

async function accessToken(db: ReturnType<typeof createClient>) {
  const { data } = await db.from("ms_tokens").select("refresh_token").eq("id", 1).single();
  if (!data) throw new Error("Outlook non collegato");
  const res = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: data.refresh_token, scope: SCOPES }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error("Token Microsoft: " + (tok.error_description ?? res.status));
  if (tok.refresh_token) await db.from("ms_tokens").update({ refresh_token: tok.refresh_token, updated_at: new Date().toISOString() }).eq("id", 1);
  return tok.access_token as string;
}
async function graph(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Graph ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
async function graphUtc(token: string, path: string, body: unknown) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: 'outlook.timezone="UTC"' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Graph ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const local = (date: string, time: string) => `${date}T${time}:00`;
const addMin = (date: string, time: string, min: number) => {
  const [h, m] = time.split(":").map(Number), t = h * 60 + m + min;
  return `${date}T${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } } });
    const { data: owner } = await supa.rpc("is_owner");
    if (owner !== true) return json({ error: "Non autorizzato" }, 401);
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const token = await accessToken(db);
    const b = await req.json();

    if (b.action === "create_task") {
      const lists = await graph(token, "GET", "/me/todo/lists");
      const list = (lists.value ?? []).find((l: any) => l.wellknownListName === "defaultList") ?? lists.value?.[0];
      const body: any = { title: b.title };
      if (b.due) body.dueDateTime = { dateTime: local(b.due, "09:00"), timeZone: TZ };
      if (b.due && b.time) { body.isReminderOn = true; body.reminderDateTime = { dateTime: local(b.due, b.time), timeZone: TZ }; }
      const t = await graph(token, "POST", `/me/todo/lists/${list.id}/tasks`, body);
      const { data } = await db.from("tasks").insert({ title: b.title, due: b.due ?? null, area: b.area === "work" ? "work" : "life", remind_at: b.due && b.time ? new Date(`${b.due}T${b.time}`).toISOString() : null,
        src: "Agyeman", email_id: b.email_id ?? null, ms_todo_id: `${list.id}|${t.id}` }).select().single();
      return json({ ok: true, task: data });
    }
    if (b.action === "create_event") {
      const e = await graphUtc(token, "/me/events", { subject: b.title,
        start: { dateTime: local(b.date, b.time), timeZone: TZ }, end: { dateTime: addMin(b.date, b.time, b.duration_min ?? 60), timeZone: TZ },
        location: b.location ? { displayName: b.location } : undefined });
      await db.from("events").upsert({ id: e.id, subject: b.title, start_at: new Date(e.start.dateTime + "Z").toISOString(), end_at: new Date(e.end.dateTime + "Z").toISOString(),
        location: b.location ?? "", area: b.area === "work" ? "work" : "life", src: "Outlook" });
      return json({ ok: true, event_id: e.id });
    }
    if (b.action === "complete_task") {
      const { data: t } = await db.from("tasks").select("*").eq("id", b.id).single();
      if (t?.ms_todo_id) { const [lid, tid] = t.ms_todo_id.split("|"); await graph(token, "PATCH", `/me/todo/lists/${lid}/tasks/${tid}`, { status: "completed" }); }
      await db.from("tasks").update({ done: true }).eq("id", b.id);
      return json({ ok: true });
    }
    return json({ error: "Azione non riconosciuta" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
