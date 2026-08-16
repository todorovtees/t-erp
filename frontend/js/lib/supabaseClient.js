// T-ERP — Supabase client
//
// The anon/public key is DESIGNED to be shipped in client-side code — it has
// no power on its own, every table is protected by Row Level Security (see
// supabase/migrations/0001_core_schema.sql). Never put the `service_role`
// key here or anywhere in the frontend.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://nkbpbbumyriecvhjykho.supabase.co';

// TODO: paste your project's anon/public key (Supabase dashboard →
// Project Settings → API → "anon public"). It's safe to commit — it is
// not a secret, RLS is what actually protects the data.
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rYnBiYnVteXJpZWN2aGp5a2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MTIyNjQsImV4cCI6MjEwMjI4ODI2NH0.MOi1qhrD1UzDg6hJDw0yMKc3RK3JLmxY41gMN_T8v5A';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Redirects to login.html if there is no active session. Call on every
 *  protected page before rendering anything sensitive. */
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = './login.html';
    return null;
  }
  return session;
}
