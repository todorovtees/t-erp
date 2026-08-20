// supabase/functions/process-user-invites/index.ts
//
// DEPLOY REQUIRED — not live until you run:
//   supabase functions deploy process-user-invites
//   supabase secrets set RESEND_API_KEY=your_key_here
// Trigger it after someone submits an invite from the Users page (the
// frontend calls this by name), or schedule it to sweep pending invites
// periodically.
//
// This is the "invite" counterpart to create-user: instead of setting a
// password immediately, it uses Supabase Auth's inviteUserByEmail (which
// sends the user a real signup link) and only creates the app_users row
// once they exist in auth.users.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) {
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: allowed } = await callerClient.rpc("has_permission", { p_module: "users", p_min: "full" });
    if (!allowed) {
      return new Response(JSON.stringify({ error: "FORBIDDEN" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { invite_id } = await req.json();

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: invite, error: fetchErr } = await admin
      .from("user_invites").select("*").eq("id", invite_id).single();
    if (fetchErr || !invite) {
      return new Response(JSON.stringify({ error: "INVITE_NOT_FOUND" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(invite.email);

    if (inviteErr || !invited.user) {
      await admin.from("user_invites").update({
        status: "failed", error_message: inviteErr?.message ?? "unknown error", processed_at: new Date().toISOString(),
      }).eq("id", invite_id);
      return new Response(JSON.stringify({ error: inviteErr?.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("app_users").insert({
      id: invited.user.id, company_id: invite.company_id,
      full_name: invite.full_name, username: invite.email.split("@")[0], role: invite.role, status: "active",
    });

    await admin.from("user_invites").update({ status: "sent", processed_at: new Date().toISOString() }).eq("id", invite_id);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
