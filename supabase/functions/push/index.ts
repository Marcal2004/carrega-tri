// Càrrega Tri · push
// Recordatori del qüestionari del matí amb notificacions web.
//   {action:"key"}   → retorna la clau pública (es crea sola la primera vegada)
//   {action:"test"}  → envia una notificació de prova a l'usuari que la crida
//   {action:"cron"}  → cada hora (pg_cron): avisa qui encara no ha fet el qüestionari
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TZ = "Europe/Madrid";
const SUBJECT = "https://marcal2004.github.io/carrega-tri/";

async function vapid() {
  let { data } = await admin.from("push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await admin.from("push_config").insert({ id: 1, public_key: k.publicKey, private_key: k.privateKey });
    ({ data } = await admin.from("push_config").select("public_key,private_key").eq("id", 1).single());
  }
  webpush.setVapidDetails(SUBJECT, data!.public_key, data!.private_key);
  return data!.public_key as string;
}

function nowMadrid() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function send(rows: { endpoint: string; sub: unknown }[], payload: Record<string, unknown>) {
  let ok = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification(r.sub as webpush.PushSubscription, JSON.stringify(payload), { TTL: 3 * 3600 });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", r.endpoint);
    }
  }
  return ok;
}

const done = (d: Record<string, unknown> | null) =>
  !!d && ["sleep", "fatigue", "soreness", "stress"].some((k) => d[k] != null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "key";

    if (action === "key") return json({ publicKey: await vapid() });

    if (action === "test") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await admin.auth.getUser(token);
      if (!user) return json({ error: "auth" }, 401);
      await vapid();
      const { data: rows } = await admin.from("push_subs").select("endpoint,sub").eq("user_id", user.id);
      const n = await send(rows || [], { title: "M.Endurance", body: "Les notificacions funcionen ✅", url: "./", tag: "test" });
      return json({ sent: n });
    }

    if (action === "cron") {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
      await vapid();
      const { date, hour } = nowMadrid();
      const { data: subs } = await admin.from("push_subs").select("endpoint,sub,user_id").eq("hour", hour);
      if (!subs?.length) return json({ sent: 0, hour });
      const users = [...new Set(subs.map((s) => s.user_id))];
      const { data: days } = await admin.from("docs").select("user_id,data").eq("coll", "daily").eq("id", date).in("user_id", users);
      const doneSet = new Set((days || []).filter((d) => done(d.data)).map((d) => d.user_id));
      const { data: coaches } = await admin.from("coaches").select("user_id").in("user_id", users);
      const coachSet = new Set((coaches || []).map((c) => c.user_id));
      const todo = subs.filter((s) => !doneSet.has(s.user_id) && !coachSet.has(s.user_id));
      const n = await send(todo, {
        title: "Control del matí ☀️",
        body: "Com t'has llevat? Fes el qüestionari, és un minut.",
        url: "./?morning=1",
        tag: "morning-" + date,
      });
      return json({ sent: n, hour, date });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
