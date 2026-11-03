// Càrrega Tri · signup
// Crea un compte NOMÉS amb un codi d'invitació vàlid generat per un entrenador.
// Els registres públics de Supabase han d'estar desactivats (Allow new users to sign up = off):
// aquesta funció crea l'usuari des del servidor i el vincula a l'entrenador del codi.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim().toUpperCase();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "code" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return json({ error: "email" }, 400);
    if (password.length < 6 || password.length > 72) return json({ error: "password" }, 400);

    const A = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const { data: inv } = await A.from("invites").select("code,coach_id,used_by,created_at").eq("code", code).maybeSingle();
    if (!inv || inv.used_by || inv.created_at < since) return json({ error: "code" }, 403);

    const { data: created, error } = await A.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created?.user) {
      const m = String(error?.message || "");
      return json({ error: /already|registered|exists/i.test(m) ? "exists" : "create" }, 400);
    }
    const uid = created.user.id;

    // Marca el codi com a usat (només si encara no ho estava) i vincula amb l'entrenador
    const { data: used } = await A.from("invites").update({ used_by: uid, used_at: new Date().toISOString() })
      .eq("code", code).is("used_by", null).select("code");
    if (!used || !used.length) { await A.auth.admin.deleteUser(uid); return json({ error: "code" }, 403); }
    await A.from("coach_links").insert({ coach_id: inv.coach_id, athlete_id: uid, athlete_email: email });

    return json({ ok: true });
  } catch (e) {
    return json({ error: "server" }, 500);
  }
});
