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

    // L'entrenador (OWNER_EMAIL) llegeix el seu propi intervals.icu i el dels seus atletes.
    // Un atleta vinculat llegeix el seu intervals.icu a través de l'accés d'entrenador (clau de l'OWNER).
    const owner = (Deno.env.get("OWNER_EMAIL") || "").trim().toLowerCase();
    const isOwner = !!owner && (user.email || "").toLowerCase() === owner;
    const sbU = createClient(Deno.env.get("SUPABASE_URL")!, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    let ath = "";
    const allowed = new Set<string>();
    if (isOwner) {
      ath = Deno.env.get("INTERVALS_ATHLETE_ID") || "";
      allowed.add(ath);
      const { data: mine } = await sbU.from("coach_links").select("intervals_id").eq("coach_id", user.id).not("intervals_id", "is", null);
      (mine || []).forEach((l: { intervals_id: string }) => allowed.add(String(l.intervals_id)));
    } else {
      const { data: links } = await sbU.from("coach_links").select("intervals_id").eq("athlete_id", user.id).not("intervals_id", "is", null).limit(1);
      ath = links && links[0] ? String(links[0].intervals_id) : "";
      if (ath) allowed.add(ath);
    }

    const body = await req.json().catch(() => ({}));
    if (typeof body.ath === "string" && body.ath) {
      if (!allowed.has(body.ath)) return json({ error: "forbidden" }, 403);
      ath = body.ath;
    }
    if (!/^i\d+$/.test(ath)) return json({ error: "nolink" }, 403);

    const auth = "Basic " + btoa("API_KEY:" + key);
    const getAbs = async (path: string) => {
      const r = await fetch(`https://intervals.icu/api/v1/${path}`, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`intervals ${r.status}`);
      return r.json();
    };
    const get = (p: string) => getAbs(`athlete/${ath}/${p}`);

    if (body.action === "detail") return json(await detail(body, get, getAbs));

    const today = new Date().toISOString().slice(0, 10);
    const newest = isDate(body.newest) ? body.newest : today;
    const oldest = isDate(body.oldest) ? body.oldest : new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const q = `oldest=${oldest}&newest=${newest}`;
    const [acts, well] = await Promise.all([get(`activities?${q}`), get(`wellness?${q}`)]);
    const activities = (Array.isArray(acts) ? acts : []).map((a: Record<string, unknown>) =>
      Object.fromEntries(ACT_KEYS.filter((k) => a[k] != null).map((k) => [k, a[k]])));
    return json({ activities, wellness: Array.isArray(well) ? well : [] });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});

// ---------- detall d'una activitat ----------
type Get = (p: string) => Promise<any>;
const DETAIL_KEYS = ["id", "external_id", "name", "type", "start_date_local", "distance", "moving_time", "elapsed_time",
  "total_elevation_gain", "average_heartrate", "max_heartrate", "average_speed", "max_speed", "average_cadence",
  "icu_average_watts", "icu_weighted_avg_watts", "calories", "icu_training_load", "average_temp", "pool_length",
  "icu_hr_zones", "icu_hr_zone_times", "pace_zones", "pace_zone_times", "icu_zone_times", "icu_power_zones", "description"];
const thin = <T,>(a: T[], n: number) => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0));

async function detail(body: Record<string, unknown>, get: Get, getAbs: Get) {
  const date = String(body.date || "");
  const gid = String(body.gid || ""), iid = String(body.iid || "");
  let id = /^i\d+$/.test(iid) ? iid : "";
  if (!id) {
    if (!isDate(date)) return { error: "date" };
    const next = new Date(Date.parse(date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
    const list = await get(`activities?oldest=${date}&newest=${next}`);
    const arr = (Array.isArray(list) ? list : []).filter((a: any) => String(a.start_date_local || "").startsWith(date));
    const start = String(body.start || "");
    const hit = arr.find((a: any) => gid && (String(a.external_id) === gid || String(a.id) === gid))
      || arr.find((a: any) => start && a.start_date && Math.abs(Date.parse(a.start_date) - Date.parse(start)) < 5 * 60000)
      || (arr.length === 1 ? arr[0] : null);
    if (!hit) return { error: "notfound" };
    id = String(hit.id);
  }
  const a = await getAbs(`activity/${id}?intervals=true`);
  const out: Record<string, unknown> = Object.fromEntries(DETAIL_KEYS.filter((k) => a[k] != null).map((k) => [k, a[k]]));
  out.laps = (Array.isArray(a.icu_intervals) ? a.icu_intervals : []).slice(0, 60).map((l: any) => ({
    type: l.type, label: l.label, distance: l.distance, moving_time: l.moving_time, elapsed_time: l.elapsed_time,
    hr: l.average_heartrate, hrMax: l.max_heartrate, speed: l.average_speed, watts: l.average_watts, cad: l.average_cadence,
  }));
  const [map, streams] = await Promise.allSettled([
    getAbs(`activity/${id}/map`),
    getAbs(`activity/${id}/streams.json?types=time,heartrate,velocity_smooth,altitude,distance`),
  ]);
  if (map.status === "fulfilled" && Array.isArray(map.value?.latlngs)) {
    out.latlngs = thin(map.value.latlngs.filter((p: any) => Array.isArray(p) && p[0] != null && p[1] != null), 500)
      .map((p: number[]) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
  }
  if (streams.status === "fulfilled" && Array.isArray(streams.value)) {
    const S: Record<string, number[]> = {};
    for (const st of streams.value) if (st && Array.isArray(st.data)) S[st.type] = st.data;
    const n = (S.time || S.distance || []).length;
    if (n) {
      const step = Math.max(1, Math.ceil(n / 300)), idx: number[] = [];
      for (let i = 0; i < n; i += step) idx.push(i);
      const pick = (k: string) => (S[k] ? idx.map((i) => (S[k][i] == null ? null : Math.round(S[k][i] * 100) / 100)) : null);
      out.streams = { time: pick("time"), hr: pick("heartrate"), speed: pick("velocity_smooth"), alt: pick("altitude"), dist: pick("distance") };
    }
  }
  return out;
}
