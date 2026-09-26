import { AppShell } from "@/layouts/AppShell";
import { ScenarioCard } from "@/components/ScenarioCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StageChip } from "@/components/StageChip";
import {
  DIFFICULTIES,
  FOCUS_STAGES,
  TRACKS,
  isDifficulty,
  isStageId,
  searchScenarios,
} from "@/services/catalog";
import { Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { stageById } from "@/types";

const ALL = "all";

export default function Catalog() {
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState<string>(ALL);
  const [difficulty, setDifficulty] = useState<string>(ALL);
  const [stage, setStage] = useState<string>(ALL);
  const [openSeatsOnly, setOpenSeatsOnly] = useState(false);

  const activeDifficulty = isDifficulty(difficulty) ? difficulty : null;
  const activeStage = isStageId(stage) ? stage : null;

  const results = useMemo(
    () =>
      searchScenarios({
        query,
        track: track === ALL ? null : track,
        difficulty: activeDifficulty,
        stage: activeStage,
        openSeatsOnly,
      }),
    [query, track, activeDifficulty, activeStage, openSeatsOnly],
  );

  const hasFilters =
    query.trim() !== "" ||
    track !== ALL ||
    difficulty !== ALL ||
    stage !== ALL ||
    openSeatsOnly;

  function reset() {
    setQuery("");
    setTrack(ALL);
    setDifficulty(ALL);
    setStage(ALL);
    setOpenSeatsOnly(false);
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="border-b border-border pb-8">
          <p className="label-mono text-brand">Scenario catalog</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
            Pick your run.
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Every scenario runs the full arc — build, submit, present, defend,
            and review. Filter by the stage you most want to get better at.
          </p>
        </div>

        {/* ── Search and filters ──────────────────────────────────── */}
        <div className="mt-8 flex flex-col gap-5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search scenarios, tracks, sponsors, or tags"
              className="h-11 pl-10"
              aria-label="Search scenarios"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="label-mono text-muted-foreground">Track</Label>
              <Select value={track} onValueChange={setTrack}>
                <SelectTrigger className="w-[190px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All tracks</SelectItem>
                  {TRACKS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="label-mono text-muted-foreground">
                Difficulty
              </Label>
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any level</SelectItem>
                  {DIFFICULTIES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="label-mono text-muted-foreground">Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any stage</SelectItem>
                  {FOCUS_STAGES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {stageById(option).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant={openSeatsOnly ? "default" : "outline"}
              onClick={() => setOpenSeatsOnly((v) => !v)}
              className="h-9"
            >
              Open seats
            </Button>

            {hasFilters && (
              <Button variant="ghost" onClick={reset} className="h-9">
                <SlidersHorizontal className="size-3.5" />
                Reset
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {results.length}
              </span>{" "}
              {results.length === 1 ? "scenario" : "scenarios"}
              {activeStage && (
                <>
                  {" "}
                  focused on{" "}
                  <StageChip stage={activeStage} className="align-middle" />
                </>
              )}
            </p>
          </div>
        </div>

        {/* ── Results ─────────────────────────────────────────────── */}
        {results.length > 0 ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {results.map((scenario) => (
              <ScenarioCard key={scenario.id} scenario={scenario} />
            ))}
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-20 text-center">
            <div className="grid size-11 place-items-center rounded-full bg-secondary">
              <SearchX className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-base font-semibold">No scenarios match</p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Try a broader search term, or clear the filters.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={reset}>
              Reset filters
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
