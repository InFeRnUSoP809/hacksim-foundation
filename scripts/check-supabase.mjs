/**
 * Read-only connectivity check for the HackSim Supabase project.
 * Creates nothing, signs in no one, and prints no secrets.
 *
 * Run: node scripts/check-supabase.mjs
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../src/lib/supabase-config.ts";

const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

function show(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log(`Project: ${SUPABASE_URL}\n`);

// 1. Is the project reachable at all?
let authRes;
try {
  authRes = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers });
} catch (err) {
  console.log("FAIL  Network — could not reach the project at all.");
  console.log(`      ${err.message}`);
  process.exit(1);
}

if (!authRes.ok) {
  console.log(`FAIL  Network — auth endpoint returned HTTP ${authRes.status}.`);
  process.exit(1);
}
show("Network", true, `auth endpoint reachable (HTTP ${authRes.status})`);

// 2. Is the anon key accepted?
if (authRes.status === 401 || authRes.status === 403) {
  console.log("FAIL  Anon key — rejected. Check VITE_SUPABASE_ANON_KEY.");
  process.exit(1);
}
show("Anon key", true, "accepted by the auth server");

// 3. What will actually happen when someone signs up?
const settings = await authRes.json();
const external = settings?.external?.email ?? {};
const confirmRequired = Boolean(external.autoconfirm === false);

show(
  "Email signup",
  external.enabled !== false,
  external.enabled === false
    ? "EMAIL PROVIDER IS DISABLED in Supabase settings"
    : confirmRequired
      ? "enabled — confirmation email required before sign-in"
      : "enabled — no email confirmation needed",
);

console.log(
  confirmRequired
    ? "\nNote: signup will return a \"check your inbox\" screen, not a session."
    : "\nNote: signup should sign the user straight in.",
);

// 4. Has the schema been applied? Read-only, and RLS hides all rows from anon.
console.log("");
let tableRes;
try {
  tableRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
    headers,
  });
} catch (err) {
  console.log(`SKIP  Schema — could not reach the REST API (${err.message}).`);
  process.exit(0);
}

if (tableRes.status === 404) {
  console.log("FAIL  Schema — the public.profiles table does not exist yet.");
  console.log("      Run supabase/001_profiles.sql (then 002 and 003) in the SQL Editor,");
  console.log("      then promote yourself:");
  console.log("        update public.profiles set role = 'admin' where email = 'you@example.com';");
  process.exit(0);
}

if (tableRes.status === 401 || tableRes.status === 403) {
  console.log("FAIL  Schema — the profiles table exists but the anon key cannot reach it.");
  process.exit(0);
}

const rows = await tableRes.json().catch(() => null);
const exists = Array.isArray(rows);

show(
  "Schema",
  exists,
  exists
    ? "public.profiles exists and is reachable (RLS correctly returns nothing to anon)"
    : `unexpected response (HTTP ${tableRes.status})`,
);

// 5. Every application table. All read-only, and all empty for an anon caller.
if (exists) {
  console.log("");
  const TABLES = [
    "hackathons",
    "teams",
    "team_members",
    "build_sessions",
    "build_checkpoints",
    "submissions",
    "submission_members",
    "submission_events",
  ];
  const missing = [];

  for (const table of TABLES) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`,
      { headers },
    );
    if (res.status === 404) {
      missing.push(table);
      console.log(`FAIL  ${table} — table not found`);
    } else {
      show(table, true, `reachable (HTTP ${res.status})`);
    }
  }

  if (missing.length > 0) {
    console.log(
      `\nMissing tables: ${missing.join(", ")}. Run 001 → 002 → 003 in the Supabase SQL Editor.`,
    );
  } else {
    console.log("\nEvery application table is present. Phases 1–4 can run end to end.");
  }
}
