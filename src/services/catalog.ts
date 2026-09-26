import type { Difficulty, Scenario, StageId } from "@/types";

/**
 * The scenario catalog.
 *
 * This is the single source of truth for `/catalog` today. It is deliberately
 * plain data with no database behind it, so it can be lifted into a
 * `scenarios` table later without touching the catalog UI — every field
 * already matches what that table would hold.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "grid-resilience",
    title: "Grid Resilience",
    sponsor: "Northwind Energy",
    track: "Climate & Infrastructure",
    difficulty: "Advanced",
    durationHours: 36,
    teamSize: 4,
    summary:
      "A regional grid operator needs a way to predict cascading failures before they cascade. Build the forecast, then defend why your model deserves trust.",
    focus: ["build", "defend"],
    tags: ["forecasting", "simulation", "critical systems"],
    seatsLeft: 4,
    featured: true,
  },
  {
    id: "clinical-triage",
    title: "Clinical Triage",
    sponsor: "Meridian Health",
    track: "Health",
    difficulty: "Advanced",
    durationHours: 24,
    teamSize: 3,
    summary:
      "Overwhelmed emergency departments need a triage tool that helps under pressure without hiding what it does not know.",
    focus: ["build", "present", "defend"],
    tags: ["triage", "decision support", "safety"],
    seatsLeft: 7,
    featured: true,
  },
  {
    id: "open-source-fund",
    title: "Maintainer Fund",
    sponsor: "The Foundry Collective",
    track: "Open Source",
    difficulty: "Open",
    durationHours: 12,
    teamSize: 2,
    summary:
      "Critical open-source projects lose maintainers every year. Build the funding and tooling layer that keeps them alive.",
    focus: ["build", "submit"],
    tags: ["sustainability", "tooling", "funding"],
    seatsLeft: null,
  },
  {
    id: "city-sensing",
    title: "City Sensing Network",
    sponsor: "Halden Civic",
    track: "Cities",
    difficulty: "Intermediate",
    durationHours: 24,
    teamSize: 4,
    summary:
      "A city wants live air-quality sensing, but the hardware has to survive a decade on a city budget. Design for the maintenance, not just the launch.",
    focus: ["build", "submit", "report"],
    tags: ["hardware", "sensors", "urban"],
    seatsLeft: 12,
  },
  {
    id: "study-companion",
    title: "Study Companion",
    sponsor: "Lumen Learning",
    track: "Education",
    difficulty: "Open",
    durationHours: 12,
    teamSize: 3,
    summary:
      "Students revise better when practice adapts to them. Build a companion that notices the gap between what they have read and what they can actually recall.",
    focus: ["build", "present"],
    tags: ["learning", "personalisation", "edtech"],
    seatsLeft: 25,
    featured: true,
  },
  {
    id: "fraud-triage",
    title: "Fraud Triage Desk",
    sponsor: "Alderline Bank",
    track: "Fintech",
    difficulty: "Advanced",
    durationHours: 36,
    teamSize: 4,
    summary:
      "A payments team is losing good customers to false positives. Build the triage that says no without becoming the thing everyone complains about.",
    focus: ["build", "defend", "report"],
    tags: ["risk", "classification", "operations"],
    seatsLeft: 3,
  },
  {
    id: "accessibility-audit",
    title: "Accessibility Audit",
    sponsor: "Public Digital Service",
    track: "Civic Tech",
    difficulty: "Intermediate",
    durationHours: 18,
    teamSize: 2,
    summary:
      "A government service fails its own accessibility standard. Find every barrier, rank them, and prove the fixes with evidence.",
    focus: ["build", "submit", "present"],
    tags: ["accessibility", "audit", "public sector"],
    seatsLeft: 18,
  },
  {
    id: "farm-water",
    title: "Farm Water Planner",
    sponsor: "Greenline Agriculture",
    track: "Climate & Infrastructure",
    difficulty: "Intermediate",
    durationHours: 24,
    teamSize: 3,
    summary:
      "Small farms cannot afford irrigation software priced like enterprise software. Build something a single farm actually runs.",
    focus: ["build", "submit"],
    tags: ["agriculture", "water", "pricing"],
    seatsLeft: 9,
  },
  {
    id: "museum-archive",
    title: "Museum Archive Explorer",
    sponsor: "Ravenscourt Museum",
    track: "Culture",
    difficulty: "Open",
    durationHours: 12,
    teamSize: 2,
    summary:
      "Forty thousand objects, no catalogue. Make an archive people can actually search, and pitch it to the trustees in five minutes.",
    focus: ["build", "present", "report"],
    tags: ["search", "archives", "culture"],
    seatsLeft: null,
  },
  {
    id: "incident-comms",
    title: "Incident Comms",
    sponsor: "Vantage Cloud",
    track: "Developer Tools",
    difficulty: "Advanced",
    durationHours: 24,
    teamSize: 4,
    summary:
      "During an outage, the status page is the product. Build the tool that keeps an honest, useful line open while everything else is on fire.",
    focus: ["build", "defend"],
    tags: ["reliability", "comms", "devtools"],
    seatsLeft: 6,
  },
  {
    id: "supply-trace",
    title: "Supply Chain Trace",
    sponsor: "Corvid Logistics",
    track: "Fintech",
    difficulty: "Advanced",
    durationHours: 36,
    teamSize: 4,
    summary:
      "A supplier cannot answer where a shipment actually is. Build provenance that survives being questioned by a regulator.",
    focus: ["build", "submit", "defend"],
    tags: ["provenance", "logistics", "compliance"],
    seatsLeft: 2,
  },
  {
    id: "quiet-hours",
    title: "Quiet Hours",
    sponsor: "Independent",
    track: "Culture",
    difficulty: "Open",
    durationHours: 12,
    teamSize: 2,
    summary:
      "An open prompt with no sponsor attached. Build whatever you think is worth building, and defend why it deserves the time.",
    focus: ["build", "present", "defend", "report"],
    tags: ["open prompt", "wildcard"],
    seatsLeft: null,
  },
];

export const TRACKS = Array.from(new Set(SCENARIOS.map((s) => s.track))).sort();

export const DIFFICULTIES: Difficulty[] = [
  "Open",
  "Intermediate",
  "Advanced",
];

export const FOCUS_STAGES: StageId[] = [
  "build",
  "submit",
  "present",
  "defend",
  "report",
];

/**
 * Type guards for values coming back from a <Select>, which only ever hands us
 * a plain string. Narrowing here keeps the filter state honest end to end.
 */
export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as string[]).includes(value);
}

export function isStageId(value: string): value is StageId {
  return (FOCUS_STAGES as string[]).includes(value);
}

/** Free-text match across the fields a participant would actually search by. */
function matchesQuery(scenario: Scenario, query: string): boolean {
  if (!query) return true;
  const haystack = [
    scenario.title,
    scenario.sponsor,
    scenario.track,
    scenario.summary,
    ...scenario.tags,
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export interface CatalogFilters {
  query?: string;
  track?: string | null;
  difficulty?: Difficulty | null;
  stage?: StageId | null;
  /** When true, only scenarios with unlimited seats are returned. */
  openSeatsOnly?: boolean;
}

/** Applies search, filters and sorting to the catalog. Pure and synchronous. */
export function searchScenarios({
  query = "",
  track = null,
  difficulty = null,
  stage = null,
  openSeatsOnly = false,
}: CatalogFilters = {}): Scenario[] {
  return SCENARIOS.filter((scenario) => {
    if (!matchesQuery(scenario, query.trim())) return false;
    if (track && scenario.track !== track) return false;
    if (difficulty && scenario.difficulty !== difficulty) return false;
    if (stage && !scenario.focus.includes(stage)) return false;
    if (openSeatsOnly && scenario.seatsLeft === 0) return false;
    return true;
  }).sort((a, b) => {
    // Featured first, then shortest event, then alphabetical — stable and obvious.
    if (Boolean(a.featured) !== Boolean(b.featured)) {
      return a.featured ? -1 : 1;
    }
    if (a.durationHours !== b.durationHours) {
      return a.durationHours - b.durationHours;
    }
    return a.title.localeCompare(b.title);
  });
}
