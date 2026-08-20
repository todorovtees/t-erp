// supabase/functions/create-user/index.ts
//
// DEPLOY REQUIRED — this file is NOT live until you run:
//   supabase functions deploy create-user
//
// Creates a new Supabase Auth user + linked app_users row in one call,
// using the service_role key SERVER-SIDE only (Deno runtime, never shipped
// to the browser). This is the piece the frontend genuinely cannot do
// safely on its own: Supabase Auth's admin API (createUser) requires the
// service_role key, and that key must never live in frontend code — it
// bypasses RLS entirely. The Users page calls this function by name
// (`supabase.functions.invoke('create-user', ...)`) instead of calling
// Supabase Auth directly.
//
// Required secrets (set with `supabase secrets set KEY=value`):
//   SUPABASE_URL              (already available by default in Edge Functions)
//   SUPABASE_SERVICE_ROLE_KEY (from Project Settings -> API -> service_role)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    // Client the CALLER is using — validates the caller's own JWT and lets
    // us check their permissions with RLS still in effect (i.e. this
    // function only creates a user if the CALLER is allowed to, matching
    // the same has_permission('users','full') rule as everywhere else).
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) {
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerProfile } = await callerClient
      .from("app_users")
      .select("company_id, role")
      .eq("id", caller.id)
      .single();

    if (!callerProfile) {
      return new Response(JSON.stringify({ error: "CALLER_PROFILE_NOT_FOUND" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Re-check permission server-side (never trust the client to have
    // already checked this) using the SAME has_permission() function every
    // other write in this schema uses.
    const { data: allowed } = await callerClient.rpc("has_permission", {
      p_module: "users", p_min: "full",
    });
    if (!allowed) {
      return new Response(JSON.stringify({ error: "FORBIDDEN: missing users full permission" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email, full_name, username, role, password } = await req.json();
    if (!email || !full_name || !username || !role || !password) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client — service_role, bypasses RLS, ONLY runs here server-side.
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: newAuthUser, error: createError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createError || !newAuthUser.user) {
      return new Response(JSON.stringify({ error: createError?.message ?? "CREATE_USER_FAILED" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: profileError } = await adminClient.from("app_users").insert({
      id: newAuthUser.user.id,
      company_id: callerProfile.company_id,
      full_name, username, role, status: "active",
    });

    if (profileError) {
      // Roll back the auth user so we don't leave an orphaned login with no profile.
      await adminClient.auth.admin.deleteUser(newAuthUser.user.id);
      return new Response(JSON.stringify({ error: profileError.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ id: newAuthUser.user.id }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
