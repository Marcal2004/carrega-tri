// Càrrega Tri · intervals-sync
// Llegeix activitats i wellness (VFC, son, pes) d'intervals.icu i els retorna a l'app.
// La clau d'intervals.icu viu només als Secrets de Supabase (INTERVALS_API_KEY).
// L'entrenador (OWNER_EMAIL) i els atletes vinculats a coach_links amb intervals_id.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const ACT_KEYS = ["id", "external_id", "start_date_local", "start_date", "type", "name", "moving_time",
  "elapsed_time", "distance", "average_heartrate", "icu_average_watts", "icu_rpe", "icu_training_load"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const anon = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, anon);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return json({ error: "auth" }, 401);

    const key = Deno.env.get("INTERVALS_API_KEY") || Deno.env.get("Intervals_api_key");
    if (!key) return json({ error: "nokey" }, 500);

    // L'entrenador (OWNER_EMAIL) llegeix el seu propi intervals.icu.
    // Un atleta vinculat llegeix el seu intervals.icu a través de l'accés d'entrenador (clau de l'OWNER).
    const owner = (Deno.env.get("OWNER_EMAIL") || "").trim().toLowerCase();
    let ath = "";
    if (owner && (user.email || "").toLowerCase() === owner) {
      ath = Deno.env.get("INTERVALS_ATHLETE_ID") || "";
    } else {
      const sbU = createClient(Deno.env.get("SUPABASE_URL")!, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: links } = await sbU.from("coach_links").select("intervals_id").eq("athlete_id", user.id).not("intervals_id", "is", null).limit(1);
      ath = links && links[0] ? String(links[0].intervals_id) : "";
      if (!ath) return json({ error: "nolink" }, 403);
    }
    if (!/^i\d+$/.test(ath)) return json({ error: "nolink" }, 403);

    const body = await req.json().catch(() => ({}));
    const today = new Date().toISOString().slice(0, 10);
    const newest = isDate(body.newest) ? body.newest : today;
    const oldest = isDate(body.oldest) ? body.oldest : new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);

    const auth = "Basic " + btoa("API_KEY:" + key);
    const get = async (p: string) => {
      const r = await fetch(`https://intervals.icu/api/v1/athlete/${ath}/${p}`, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`intervals ${r.status}`);
      return r.json();
    };
    const q = `oldest=${oldest}&newest=${newest}`;
    const [acts, well] = await Promise.all([get(`activities?${q}`), get(`wellness?${q}`)]);
    const activities = (Array.isArray(acts) ? acts : []).map((a: Record<string, unknown>) =>
      Object.fromEntries(ACT_KEYS.filter((k) => a[k] != null).map((k) => [k, a[k]])));
    return json({ activities, wellness: Array.isArray(well) ? well : [] });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
