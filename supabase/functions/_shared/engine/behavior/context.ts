/**
 * Context for implementation patterns — avoids blind interpretation of syntax.
 */

const UI_HINT_RE =
  /render|display|jsx|tsx|className|useState|setState|\.map\s*\(.*=>\s*</i;
const AI_BODY_RE =
  /fetch\s*\(|axios|openai|deepseek|anthropic|completions|chat\.|invoke\s*\(/i;
const PARSE_AFTER_AI_RE = /JSON\.parse|json\.loads|\.json\s*\(\s*\)/i;
const PROMPT_BODY_RE = /prompt|messages\s*:|getPrompt|loadPrompt|from\s*\(\s*['"]prompts/i;

export type LimitInterpretation =
  | "post_ai_or_api_processing"
  | "ui_display_only"
  | "unknown";

export function classifyLimitContext(input: {
  filePath: string;
  symbolBody: string | null;
  line: string;
}): LimitInterpretation {
  const body = input.symbolBody ?? input.line;
  const isFrontend =
    /pages?\/|components?\/|\.tsx$|\.jsx$|\.vue$/i.test(input.filePath);

  if (UI_HINT_RE.test(body) && !AI_BODY_RE.test(body) && !PARSE_AFTER_AI_RE.test(body)) {
    return "ui_display_only";
  }

  const hasAi = AI_BODY_RE.test(body);
  const hasParse = PARSE_AFTER_AI_RE.test(body);
  const hasPrompt = PROMPT_BODY_RE.test(body);
  const hasPersist = /\.insert|\.upsert|INSERT INTO|\.update\s*\(/i.test(body);

  if (hasAi && (hasParse || hasPrompt || hasPersist)) {
    return "post_ai_or_api_processing";
  }

  if (hasParse && /\.slice\s*\(\s*0|\.take\s*\(|limit\s*\(/i.test(input.line)) {
    return "post_ai_or_api_processing";
  }

  if (isFrontend && !hasAi && !hasParse) {
    return "ui_display_only";
  }

  return "unknown";
}

export function limitClaimWithContext(
  target: string,
  limit: string,
  interpretation: LimitInterpretation,
): string {
  const base = `Limits \`${target.trim()}\` to at most ${limit} element(s)`;
  if (interpretation === "post_ai_or_api_processing") {
    return `${base} within a handler that also performs AI/JSON/persistence work`;
  }
  if (interpretation === "ui_display_only") {
    return `${base} (likely UI/display truncation in this symbol; not standalone proof of business rule)`;
  }
  return `${base} (interpretation requires surrounding workflow context)`;
}
