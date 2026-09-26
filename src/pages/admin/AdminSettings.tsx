import { AdminLayout } from "@/layouts/AdminLayout";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/lib/theme";
import { Settings2 } from "lucide-react";
import { useState } from "react";

/**
 * Settings that genuinely work today. Anything that needs server-side
 * configuration is listed but explicitly not wired, rather than faked.
 */
export default function AdminSettings() {
  const { theme, setTheme } = useTheme();
  const [breakMinutes, setBreakMinutes] = useState(10);

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Settings
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Preferences for this device and the current browser session.
        </p>
      </div>

      <div className="mt-8 grid max-w-2xl gap-4">
        {/* ── Appearance ───────────────────────────────────────── */}
        <Card className="flex flex-row items-center justify-between gap-6 p-6">
          <div>
            <h2 className="text-sm font-semibold tracking-[-0.01em]">
              Appearance
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {theme === "dark"
                ? "Currently using the dark theme."
                : "Currently using the light theme."}{" "}
              Saved in this browser only.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={
                theme === "light"
                  ? "rounded-md border border-brand bg-brand/10 px-3 py-1.5 text-sm font-medium text-brand"
                  : "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              Light
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={
                theme === "dark"
                  ? "rounded-md border border-brand bg-brand/10 px-3 py-1.5 text-sm font-medium text-brand"
                  : "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              Dark
            </button>
          </div>
        </Card>

        {/* ── Break configuration ───────────────────────────────── */}
        <Card className="p-6">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">
            Break length
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            How long a student's break lasts when they take one. The build
            clock keeps running through a break.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="break-minutes">Break minutes</Label>
              <input
                id="break-minutes"
                type="number"
                min={1}
                max={120}
                value={breakMinutes}
                onChange={(event) =>
                  setBreakMinutes(Number(event.target.value) || 1)
                }
                className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <p className="pb-2 text-xs text-muted-foreground">
              Applied from this browser. A database-wide default is a later
              addition.
            </p>
          </div>
        </Card>

        {/* ── Not yet implemented ───────────────────────────────── */}
        <Card className="flex items-start gap-3 border-dashed p-6">
          <Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold tracking-[-0.01em]">
              Not configurable yet
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              AI model selection, judging rubrics, and automatic break scheduling
              are not built. Nothing here is a placeholder that pretends to save.
            </p>
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}
