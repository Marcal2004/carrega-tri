// Càrrega Tri · intervals-sync
// Llegeix activitats i wellness (VFC, son, pes) d'intervals.icu i els retorna a l'app.
// La clau d'intervals.icu viu només als Secrets de Supabase (INTERVALS_API_KEY).
// L'entrenador (OWNER_EMAIL) i els atletes vinculats a coach_links amb intervals_id.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
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
    const body = await req.json().catch(() => ({}));
    const key0 = Deno.env.get("INTERVALS_API_KEY") || Deno.env.get("Intervals_api_key") || "";

    // Sincronització diària de tots els atletes (pg_cron)
    if (body.action === "storeAll") {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
      const { data: links } = await admin().from("coach_links").select("athlete_id,coach_id,intervals_id").not("intervals_id", "is", null);
      const seen = new Set<string>(), out: Record<string, unknown> = {};
      for (const l of links || []) { if (seen.has(l.athlete_id)) continue; seen.add(l.athlete_id);
        try {
          const r: any = await storeFor(l.athlete_id, String(l.intervals_id), key0);
          const fresh = r.fresh || []; delete r.fresh; out[l.athlete_id] = r;
          if (fresh.length) r.notified = await notifyActivities(l.athlete_id, l.coach_id, fresh);
        } catch (e) { out[l.athlete_id] = String((e as Error).message); } }
      return json({ ok: true, out });
    }

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
      // Compte d'entrenador (sense dades pròpies): pot llegir els seus atletes
      const { data: coached } = await sbU.from("coach_links").select("intervals_id").eq("coach_id", user.id).not("intervals_id", "is", null);
      (coached || []).forEach((l: { intervals_id: string }) => allowed.add(String(l.intervals_id)));
    }

    // Guardar a la base de dades (des del servidor) les dades d'un atleta: ell mateix o el seu entrenador
    if (body.action === "store") {
      const uid = typeof body.uid === "string" && body.uid ? body.uid : user.id;
      const A = admin();
      if (uid !== user.id) {
        const { data: ok } = await A.from("coach_links").select("athlete_id").eq("coach_id", user.id).eq("athlete_id", uid).maybeSingle();
        if (!ok) return json({ error: "forbidden" }, 403);
      }
      let iid = "";
      const { data: ln } = await A.from("coach_links").select("intervals_id").eq("athlete_id", uid).not("intervals_id", "is", null).limit(1);
      if (ln && ln[0]) iid = String(ln[0].intervals_id);
      if (!iid && uid === user.id && isOwner) iid = Deno.env.get("INTERVALS_ATHLETE_ID") || "";
      if (!/^i\d+$/.test(iid)) return json({ error: "nolink" }, 403);
      const r: any = await storeFor(uid, iid, key); const fresh = r.fresh || []; delete r.fresh;
      if (fresh.length) { try { r.notified = await notifyActivities(uid, null, fresh); } catch (_) { /* sense avís */ } }
      return json(r);
    }

    // Enviar el pla de dies concrets al calendari d'intervals.icu (i d'allà al rellotge)
    if (body.action === "push") {
      const uid = typeof body.uid === "string" && body.uid ? body.uid : user.id;
      const A = admin();
      if (uid !== user.id) {
        const { data: ok } = await A.from("coach_links").select("athlete_id").eq("coach_id", user.id).eq("athlete_id", uid).maybeSingle();
        if (!ok) return json({ error: "forbidden" }, 403);
      }
      let iid = "";
      const { data: ln } = await A.from("coach_links").select("intervals_id").eq("athlete_id", uid).not("intervals_id", "is", null).limit(1);
      if (ln && ln[0]) iid = String(ln[0].intervals_id);
      if (!iid && uid === user.id && isOwner) iid = Deno.env.get("INTERVALS_ATHLETE_ID") || "";
      if (!/^i\d+$/.test(iid)) return json({ error: "nolink" }, 403);
      const dates = (Array.isArray(body.dates) ? body.dates : []).filter(isDate).slice(0, 14);
      return json(await pushDays(uid, iid, dates, key));
    }

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

// ---------- guardar des del servidor ----------
const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const madridToday = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const nnum = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
function mapType(t: unknown) { const u = String(t || "").toUpperCase(); if (/SWIM/.test(u)) return "Natació"; if (/RUN|TREADMILL|TRAIL/.test(u)) return "Carrera"; if (/BIK|CYCL|RIDE|SPIN|GRAVEL/.test(u)) return "Ciclisme"; if (/STRENGTH|WEIGHT|GYM|HIIT/.test(u)) return "Força"; return null; }

/* ---------- avís d'activitat nova (notificació al mòbil) ---------- */
let vapidOk: boolean | null = null;
async function vapidReady() {
  if (vapidOk !== null) return vapidOk;
  const { data } = await admin().from("push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (!data) return (vapidOk = false);
  webpush.setVapidDetails("https://marcal2004.github.io/carrega-tri/", data.public_key, data.private_key);
  return (vapidOk = true);
}
async function pushTo(userId: string, payload: Record<string, unknown>) {
  const A = admin(); const { data: subs } = await A.from("push_subs").select("endpoint,sub").eq("user_id", userId);
  let ok = 0;
  for (const r of subs || []) {
    try { await webpush.sendNotification(r.sub as webpush.PushSubscription, JSON.stringify(payload), { TTL: 6 * 3600 }); ok++; }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await A.from("push_subs").delete().eq("endpoint", r.endpoint); }
  }
  return ok;
}
function actTxt(s: any) {
  const d = s.disc === "Natació" && s.m ? `${s.m.toLocaleString("ca-ES")} m` : s.km ? `${String(s.km).replace(".", ",")} km` : "";
  const t = s.min >= 60 ? `${Math.floor(s.min / 60)}h${String(s.min % 60).padStart(2, "0")}` : `${s.min}′`;
  return [s.disc, d, t].filter(Boolean).join(" · ");
}
async function notifyActivities(uid: string, coachId: string | null, fresh: any[]) {
  if (!(await vapidReady())) return 0;
  const recent = fresh.filter((s) => s.date >= addDays(madridToday(), -1));   // només d'avui o d'ahir
  if (!recent.length) return 0;
  const { data: p } = await admin().from("docs").select("data").eq("user_id", uid).eq("coll", "profile").eq("id", "profile").maybeSingle();
  const prof: any = p?.data || {}; const name = prof.name || "L'atleta";
  let n = 0;
  const body = recent.length === 1 ? actTxt(recent[0]) : `${recent.length} activitats: ${recent.map((s) => s.disc).join(", ")}`;
  if (prof.notifAct !== false) n += await pushTo(uid, { title: "Nova activitat 🏁", body: body + " · posa-hi l'RPE", url: "./", tag: "act-" + uid });
  if (coachId && coachId !== uid) n += await pushTo(coachId, { title: `${name} ha entrenat`, body, url: "./", tag: "act-" + uid });
  return n;
}
async function storeFor(uid: string, iid: string, key: string) {
  if (!key) throw new Error("nokey");
  const A = admin(), auth = "Basic " + btoa("API_KEY:" + key);
  const get = async (p: string) => { const r = await fetch(`https://intervals.icu/api/v1/athlete/${iid}/${p}`, { headers: { Authorization: auth } }); if (!r.ok) throw new Error(`intervals ${r.status}`); return r.json(); };
  const today = madridToday(), oldest = addDays(today, -14), q = `oldest=${oldest}&newest=${today}`;
  const [acts, well] = await Promise.all([get(`activities?${q}`), get(`wellness?${q}`)]);
  const { data: rows } = await A.from("docs").select("coll,id,data").eq("user_id", uid).in("coll", ["sessions", "daily", "weights", "profile"]);
  const S: Record<string, any> = {}, D: Record<string, any> = {}, W: Record<string, any> = {}; let prof: any = {};
  for (const r of rows || []) { if (r.coll === "sessions") S[r.id] = r.data; else if (r.coll === "daily") D[r.id] = r.data; else if (r.coll === "weights") W[r.id] = r.data; else prof = r.data || {}; }
  const ignored = new Set<string>(Array.isArray(prof.garminIgnored) ? prof.garminIgnored : []);
  const sessList = Object.values(S);
  const up: any[] = [], now = new Date().toISOString();
  const list = (Array.isArray(acts) ? acts : []).map((a: any) => ({ ...a, disc: mapType(a.type), gid: String(a.external_id || a.id || ""), t0: Date.parse(a.start_date || a.start_date_local), sec: a.moving_time || a.elapsed_time || 0 }))
    .filter((a: any) => a.gid && a.start_date_local).sort((a: any, b: any) => a.t0 - b.t0);
  let added = 0; const fresh: any[] = [];
  for (const a of list) {
    if (!a.disc) continue;
    const id = "g-" + a.gid.replace(/[^A-Za-z0-9_-]/g, "");
    if (S[id] || ignored.has(a.gid)) continue;
    const date = String(a.start_date_local).slice(0, 10), min = Math.max(1, Math.round(a.sec / 60));
    const dup = sessList.some((s: any) => s.date === date && s.disc === a.disc && s.min && Math.abs(s.min - min) / Math.max(s.min, min) < 0.08);
    if (dup) continue;
    const s: any = { date, disc: a.disc, min, rpe: null, pending: true, source: "garmin", gid: a.gid, iid: String(a.id), start: a.start_date || a.start_date_local, desc: a.name || a.disc, brick: false };
    if (a.disc === "Natació" && a.distance) s.m = Math.round(a.distance);
    if ((a.disc === "Ciclisme" || a.disc === "Carrera") && a.distance) s.km = Math.round(a.distance / 100) / 10;
    if (a.average_heartrate && a.disc !== "Natació") s.fc = Math.round(a.average_heartrate);
    if (a.disc === "Ciclisme" && a.icu_average_watts) s.w = Math.round(a.icu_average_watts);
    if (a.disc === "Carrera") s.brick = list.some((b: any) => b.disc === "Ciclisme" && Math.abs(a.t0 - (b.t0 + (b.elapsed_time || b.sec) * 1000)) < 20 * 60000);
    S[id] = s; sessList.push(s); up.push({ user_id: uid, coll: "sessions", id, data: s, updated_at: now }); added++; fresh.push(s);
  }
  let wn = 0;
  for (const r of Array.isArray(well) ? well : []) {
    const d = String(r.id || "").slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const g: any = {};
    let hv = nnum(r.hrv); if (hv == null) for (const [k, v] of Object.entries(r)) if (/hrv|rmssd/i.test(k) && !/sdnn/i.test(k) && nnum(v) != null) { hv = v as number; break; }
    if (hv != null) g.hrvG = Math.round(hv);
    if (nnum(r.sleepScore) != null) g.sleepScore = Math.round(r.sleepScore);
    if (nnum(r.sleepSecs) != null) g.sleepH = Math.round(r.sleepSecs / 360) / 10;
    if (nnum(r.restingHR) != null) g.rhr = r.restingHR;
    if (Object.keys(g).length) {
      const ex = D[d] || {}, cur = ex.garmin || {};
      const nd: any = { ...ex, garmin: { ...cur, ...g } };
      if (g.hrvG != null && (ex.hrv == null || ex.hrvSrc === "garmin")) { nd.hrv = g.hrvG; nd.hrvSrc = "garmin"; }
      if (JSON.stringify(nd) !== JSON.stringify(ex)) { up.push({ user_id: uid, coll: "daily", id: d, data: nd, updated_at: now }); wn++; }
    }
    if (nnum(r.weight) != null && !W[d]) up.push({ user_id: uid, coll: "weights", id: d, data: { kg: Math.round(r.weight * 10) / 10, note: "Garmin" }, updated_at: now });
  }
  for (let i = 0; i < up.length; i += 200) { const { error } = await A.from("docs").upsert(up.slice(i, i + 200)); if (error) throw new Error(error.message); }
  return { added, wellness: wn, fresh };
}

// ---------- enviar al rellotge ----------
const EV_TYPE: Record<string, string> = { Carrera: "Run", Ciclisme: "Ride", "Natació": "Swim", "Força": "WeightTraining" };
const BLK_L: [string, string][] = [["warm", "Escalfament"], ["main", "Bloc principal"], ["cool", "Final"], ["notes", "Notes"]];
function eventDesc(it: any) {
  const human = BLK_L.some(([k]) => it[k]) ? BLK_L.filter(([k]) => it[k]).map(([k, l]) => `${l}: ${it[k]}`).join("\n") : String(it.detail || "");
  const watch = String(it.watch || "").trim();
  // El text descriptiu no ha de semblar un pas (línies amb "-" o "4x"): es neteja perquè intervals no el converteixi en passos
  const safe = human.split("\n").map((x) => x.replace(/^\s*-\s*/, "• ").replace(/^(\s*)(\d+)\s*[xX](?=\s|\d|$)/, "$1$2×")).join("\n");
  if (watch) return safe ? `${safe}\n\n${watch}` : watch;
  // Sense format de rellotge: un sol pas amb la durada prevista i el text com a notes
  return safe + (it.min ? `\n\n- ${Math.round(it.min)}m` : "");
}
async function pushDays(uid: string, iid: string, dates: string[], key: string) {
  const A = admin(), auth = "Basic " + btoa("API_KEY:" + key);
  const call = async (method: string, path: string, payload?: unknown) => {
    const r = await fetch(`https://intervals.icu/api/v1/athlete/${iid}/${path}`, { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
    if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`intervals ${r.status}`);
    return method === "DELETE" ? null : r.json();
  };
  const { data: rows } = await A.from("docs").select("coll,id,data").eq("user_id", uid).in("coll", ["dayplan", "push"]).in("id", dates);
  const plan: Record<string, any> = {}, pushed: Record<string, string[]> = {};
  for (const r of rows || []) { if (r.coll === "dayplan") plan[r.id] = r.data; else pushed[r.id] = Array.isArray(r.data?.ids) ? r.data.ids : []; }
  const now = new Date().toISOString(), out: Record<string, number> = {}, up: any[] = [];
  for (const d of dates) {
    const doc = plan[d], items = Array.isArray(doc?.items) ? doc.items : [], keep: string[] = [];
    // Primer enviament d'aquest dia: aprofita els entrenos que ja hi ha al calendari (posats a mà)
    // per actualitzar-los en lloc de crear-ne de duplicats.
    let free: any[] = [];
    if (!(d in pushed)) {
      try {
        const evs: any = await call("GET", `events?oldest=${d}&newest=${d}&category=WORKOUT`);
        free = (Array.isArray(evs) ? evs : []).filter((e: any) => e && e.category === "WORKOUT" && String(e.start_date_local || "").slice(0, 10) === d);
      } catch (_) { free = []; }
    }
    let n = 0;
    for (const it of items) {
      if (!it || !EV_TYPE[it.disc]) continue;
      if (!it.iev && free.length) {
        const i = free.findIndex((e: any) => e.type === EV_TYPE[it.disc]);
        if (i >= 0) {
          it.iev = String(free[i].id);
          // Conserva l'estructura (passos) de l'entreno que ja hi havia, si l'entrenador no n'ha posat cap
          const old = String(free[i].description || "");
          if (!String(it.watch || "").trim() && /^\s*(-\s|\d+x\b)/m.test(old)) it.watch = old.trim();
          free.splice(i, 1);
        }
      }
      const ev = { category: "WORKOUT", start_date_local: `${d}T00:00:00`, type: EV_TYPE[it.disc], name: it.title || it.disc, description: eventDesc(it), moving_time: it.min ? Math.round(it.min * 60) : undefined };
      let id = it.iev ? String(it.iev) : "";
      try { if (id) await call("PUT", `events/${id}`, ev); else { const r: any = await call("POST", "events", ev); id = String(r.id); } }
      catch (_) { const r: any = await call("POST", "events", ev); id = String(r.id); }
      it.iev = id; keep.push(id); n++;
    }
    for (const old of pushed[d] || []) if (!keep.includes(old)) { try { await call("DELETE", `events/${old}`); } catch (_) { /* ja no hi era */ } }
    if (doc) up.push({ user_id: uid, coll: "dayplan", id: d, data: { ...doc, items, pushedAt: now }, updated_at: now });
    up.push({ user_id: uid, coll: "push", id: d, data: { ids: keep, at: now }, updated_at: now });
    out[d] = n;
  }
  if (up.length) { const { error } = await A.from("docs").upsert(up); if (error) throw new Error(error.message); }
  return { ok: true, sent: out };
}
