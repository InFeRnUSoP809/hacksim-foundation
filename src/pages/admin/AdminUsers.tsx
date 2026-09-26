import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useAsync } from "@/hooks/use-async";
import { formatDate } from "@/lib/format";
import { displayName } from "@/lib/format";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Role } from "@/types";

interface AdminUser {
  id: string;
  full_name: string | null;
  email: string;
  role: Role;
  created_at: string;
  team_name: string | null;
}

/**
 * Admin can read every row of `profiles` (the RLS policy allows exactly that),
 * so this is a plain select — no elevated function required.
 */
async function loadUsers(): Promise<AdminUser[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;

  // Team membership lives in team_members; fetch names separately so a user
  // without a team still appears in the list.
  const { data: memberships } = await supabase
    .from("team_members")
    .select("user_id, teams(name)");

  const teamByUser = new Map<string, string>();
  for (const row of (memberships ?? []) as {
    user_id: string;
    teams: { name: string }[] | null;
  }[]) {
    const name = row.teams?.[0]?.name;
    if (name) teamByUser.set(row.user_id, name);
  }

  return (data as AdminUser[]).map((user) => ({
    ...user,
    team_name: teamByUser.get(user.id) ?? null,
  }));
}

export default function AdminUsers() {
  const users = useAsync<AdminUser[]>(() => loadUsers(), []);

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Users
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Everyone with a HackSim account, and the team they belong to.
        </p>
      </div>

      <div className="mt-8">
        {users.isLoading ? (
          <LoadingState label="Loading users" />
        ) : users.error ? (
          <ErrorState message={users.error} />
        ) : (users.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Users className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No users yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Accounts appear here as soon as somebody signs up.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Name
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Email
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Role
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Team
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(users.data ?? []).map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-5 py-3.5 font-medium">
                        {displayName(user.full_name, user.email)}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {user.email}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            "label-mono inline-flex rounded-full border px-2.5 py-1 capitalize",
                            user.role === "admin"
                              ? "border-brand/35 bg-brand/10 text-brand"
                              : "border-border bg-muted text-muted-foreground",
                          )}
                        >
                          {user.role}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {user.team_name ?? "—"}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {formatDate(user.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
