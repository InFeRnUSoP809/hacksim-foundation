#!/usr/bin/env bash
#
# Build self-contained edge function bundles for dashboard deployment.
#
# The Supabase dashboard accepts one file per function, but `analysis/index.ts`
# and `ai-admin/index.ts` import nine modules from `_shared/`. Pasting either
# entry point as-is fails immediately with an unresolved import. This inlines
# every `_shared` module into a single file, so each function can be pasted
# into the dashboard verbatim.
#
# The CLI does this automatically (`supabase functions deploy`); this exists
# only for deploying through the web UI.
#
# Run:  bash scripts/bundle-functions.sh
#
# @supabase/supabase-js is left external: the Supabase runtime resolves it, and
# inlining a client library would bury the actual function under 300 KB of
# vendored code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTIONS="$ROOT/supabase/functions"
OUT="$FUNCTIONS/bundle"
mkdir -p "$OUT"

bundle() {
  local name="$1"
  # esbuild resolves the entry relative to its own cwd, so the path is absolute
  # and the working directory is set rather than assumed.
  local entry="$FUNCTIONS/$name/index.ts"

  (cd "$FUNCTIONS" && npx --yes esbuild "$entry" \
    --bundle \
    --format=esm \
    --platform=neutral \
    --target=es2022 \
    --external:@supabase/supabase-js \
    --outfile="$OUT/$name.ts" \
    --log-level=warning)

  # The dashboard's bundler rejects a bare specifier. It requires npm:/jsr:/https:
  # on every import that is not a relative path, so the one external the CLI
  # resolves from deno.json has to be rewritten here.
  #
  #   "Relative import path \"@supabase/supabase-js\" not prefixed with / or ./ or ../"
  #
  # Rewriting with sed rather than letting esbuild bundle it: the Supabase
  # runtime supplies the client, and inlining it would bury the function under
  # 300 KB of vendored code.
  sed -i \
    -e 's#from "@supabase/supabase-js"#from "npm:@supabase/supabase-js@2"#g' \
    -e "s#from 'npm:@supabase/supabase-js'#from 'npm:@supabase/supabase-js@2'#g" \
    "$OUT/$name.ts"

  # Fail loudly rather than shipping a bundle the dashboard will reject.
  # A specifier is bare unless it starts with /, ./, ../ or a URL scheme
  # (npm:, jsr:, https:, http:).
  local bare
  bare=$(grep -nE 'from "[^"]+"' "$OUT/$name.ts" \
    | grep -vE 'from "(\.|/|npm:|jsr:|https?:)' || true)
  if [ -n "$bare" ]; then
    echo "ERROR: $name has import specifiers the dashboard will reject:" >&2
    echo "$bare" >&2
    exit 1
  fi

  # A banner so nobody edits a generated file by hand and loses the change.
  local lines
  lines=$(wc -l < "$OUT/$name.ts")
  printf '%s\n' \
    "// ─────────────────────────────────────────────────────────────────────" \
    "// GENERATED FILE — do not edit." \
    "//" \
    "// Built by scripts/bundle-functions.sh from" \
    "//   supabase/functions/$name/index.ts" \
    "// plus supabase/functions/_shared/** (including engine/)" \
    "//" \
    "// Edit the sources, then re-run the script. Changes made here are lost." \
    "// $lines lines, self-contained — safe to paste into the Supabase dashboard." \
    "// ─────────────────────────────────────────────────────────────────────" \
    "" > "$OUT/$name.header"

  cat "$OUT/$name.header" "$OUT/$name.ts" > "$OUT/$name.tmp"
  mv "$OUT/$name.tmp" "$OUT/$name.ts"
  rm -f "$OUT/$name.header"

  if [ "$name" = "analysis" ]; then
    if ! grep -q 'hacksim-analysis-v1' "$OUT/$name.ts" || ! grep -q 'new-engine-v1' "$OUT/$name.ts"; then
      echo "ERROR: $name production bundle missing v1 engine identity — rebuild from analysis/index.ts" >&2
      exit 1
    fi
    if grep -q '// _shared/scanner.ts' "$OUT/$name.ts" || grep -qE 'SCANNER_VERSION = "p5-' "$OUT/$name.ts"; then
      echo "ERROR: $name bundle still contains legacy inlined scanner — rebuild" >&2
      exit 1
    fi
  fi

  printf '%-12s %s lines  %s\n' "$name" "$(wc -l < "$OUT/$name.ts")" "$OUT/$name.ts"
}

echo "Bundling edge functions for dashboard deployment…"
bundle analysis
bundle ai-admin
echo
echo "Done. Paste each file into Supabase → Edge Functions → Deploy a new function."
