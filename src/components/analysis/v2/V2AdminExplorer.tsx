import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getV2EvidenceDetail,
  getV2EvidencePage,
  getV2RelationshipsPage,
} from "@/lib/api";
import { useEffect, useState } from "react";

export function V2AdminEvidenceExplorer(props: { runId: string }) {
  const [page, setPage] = useState(0);
  const [level, setLevel] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const limit = 20;

  useEffect(() => {
    void getV2EvidencePage(props.runId, {
      limit,
      offset: page * limit,
      level: level === "all" ? undefined : level,
      search: search || undefined,
    }).then((res) => {
      setItems(res.items as Record<string, unknown>[]);
      setTotal(res.total);
    });
  }, [props.runId, page, level, search]);

  async function openEvidence(id: string) {
    const detail = await getV2EvidenceDetail(props.runId, id);
    setSelected(detail);
  }

  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-medium">Evidence explorer</h3>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search claim or file"
          value={search}
          onChange={(e) => {
            setPage(0);
            setSearch(e.target.value);
          }}
          className="max-w-xs"
        />
        <Select value={level} onValueChange={(v) => { setPage(0); setLevel(v); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="implementation">Implementation</SelectItem>
            <SelectItem value="relationship">Relationship</SelectItem>
            <SelectItem value="structural">Structural</SelectItem>
            <SelectItem value="metadata">Metadata</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ul className="text-sm space-y-2 max-h-64 overflow-auto">
        {items.map((row) => (
          <li key={String(row.evidence_id)}>
            <button
              type="button"
              className="text-left hover:underline w-full"
              onClick={() => void openEvidence(String(row.evidence_id))}
            >
              <span className="font-mono text-xs">{String(row.evidence_id)}</span>
              {" — "}
              {String(row.claim).slice(0, 120)}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={(page + 1) * limit >= total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
        <span className="text-xs text-muted-foreground self-center">{total} total</span>
      </div>
      {selected && (
        <Card className="p-3 bg-muted/30 text-sm">
          <p className="font-mono text-xs">{String(selected.evidence_id)}</p>
          <p className="mt-1">{String(selected.file_path)}</p>
          <p className="text-xs text-muted-foreground">
            Lines {String(selected.start_line)}–{String(selected.end_line)}
          </p>
          <pre className="mt-2 text-xs whitespace-pre-wrap max-h-40 overflow-auto">
            {String(selected.snippet_excerpt ?? "")}
          </pre>
        </Card>
      )}
    </Card>
  );
}

const REL_TYPES = [
  "imports", "calls", "calls_api", "routes_to", "reads_database", "writes_database",
  "calls_ai_provider", "loads_prompt", "parses_response", "persists_result", "tests",
];

export function V2AdminRelationshipExplorer(props: { runId: string }) {
  const [page, setPage] = useState(0);
  const [type, setType] = useState("all");
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const limit = 30;

  useEffect(() => {
    void getV2RelationshipsPage(props.runId, {
      limit,
      offset: page * limit,
      type: type === "all" ? undefined : type,
    }).then((res) => {
      setItems(res.items as Record<string, unknown>[]);
      setTotal(res.total);
    });
  }, [props.runId, page, type]);

  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-medium">Relationship explorer</h3>
      <Select value={type} onValueChange={(v) => { setPage(0); setType(v); }}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {REL_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ul className="text-xs font-mono space-y-1 max-h-72 overflow-auto">
        {items.map((row, i) => (
          <li key={i}>
            {String(row.relationship_type)} · {String(row.source_file)} · {String(row.confidence)}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={(page + 1) * limit >= total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </Card>
  );
}
