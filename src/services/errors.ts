/**
 * Turns a Supabase/PostgREST error into something worth showing a person.
 *
 * Errors raised by our SQL functions arrive as plain sentences, so they are
 * already user-facing. The interesting cases here are the ones that are not:
 * a network failure, a missing table, or an RLS denial.
 */
export function friendlyError(error: unknown, fallback = "Something went wrong."): string {
  if (!error) return fallback;

  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "";

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Couldn't reach the HackSim server. Check your connection and reload.";
  }

  if (
    /relation .* does not exist|schema cache/i.test(message) ||
    /Could not find the table/i.test(message)
  ) {
    return (
      "The database isn't set up yet. Run supabase/phase2.sql in the Supabase SQL Editor."
    );
  }

  if (/row-level security|permission denied|violates row-level/i.test(message)) {
    return "You don't have permission to do that.";
  }

  if (/JWT|invalid login credentials/i.test(message)) {
    return "Your session has expired. Please sign in again.";
  }

  return message || fallback;
}
