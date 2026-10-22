/**
 * Context budget for the AI chat: estimate what each request carries, trim bulky tool output, and fold older
 * turns into a short summary so a long session does not run into the model's limit (or the bill).
 */
import type { AiMsg, AiPart, AiSettings, AiTool } from "../api";

export type ContextMode = "compact" | "trim" | "off";
export const SUMMARY_TAG = "[Summary of the earlier conversation]";
/** Compact / trim once the context passes this share of the limit. */
export const THRESHOLD = 0.8;
/** The newest user prompts (with everything that followed them) always stay verbatim. */
const KEEP_TURNS = 2;
export const LIMIT_PRESETS = [16_000, 32_000, 64_000, 128_000, 200_000];

/** Rough token count: about 3.5 characters per token for English and code. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

function partText(p: AiPart): string {
  if (p.type === "text") return p.text;
  if (p.type === "tool_use") return `${p.name} ${JSON.stringify(p.input ?? {})}`;
  return p.content;
}
export const messageTokens = (m: AiMsg) => m.content.reduce((n, p) => n + estimateTokens(partText(p)) + 4, 4);
export const historyTokens = (h: AiMsg[]) => h.reduce((n, m) => n + messageTokens(m), 0);
export const toolsTokens = (tools: AiTool[]) => estimateTokens(JSON.stringify(tools));

/** Context window of well-known models; anything else is assumed to have 128k. */
export function modelWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("claude")) return 200_000;
  if (/gpt-4\.1|gpt-5|o[134]\b/.test(m)) return 400_000;
  return 128_000;
}

/** The budget in tokens: the user's limit, or "auto" = the model's window capped at 200k. */
export function contextLimit(ai: Pick<AiSettings, "contextLimit"> | undefined, model: string): number {
  const v = ai?.contextLimit ?? 0;
  return v > 0 ? v : Math.min(modelWindow(model), 200_000);
}

export const contextMode = (ai: Pick<AiSettings, "contextMode"> | undefined): ContextMode => (ai?.contextMode === "trim" || ai?.contextMode === "off" ? ai.contextMode : "compact");

export interface ContextInfo { system: number; tools: number; chat: number; total: number; limit: number; pct: number; messages: number }
export function contextInfo(system: string, tools: AiTool[], history: AiMsg[], limit: number): ContextInfo {
  const s = estimateTokens(system), t = toolsTokens(tools), c = historyTokens(history);
  const total = s + t + c;
  return { system: s, tools: t, chat: c, total, limit, pct: Math.min(999, Math.round((total / Math.max(1, limit)) * 100)), messages: history.length };
}

export const isPrompt = (m: AiMsg) => m.role === "user" && m.content.some((p) => p.type === "text" && p.text.trim() && !p.text.startsWith(SUMMARY_TAG));
const startsTurn = (m: AiMsg) => m.role === "user" && m.content.some((p) => p.type === "text" && p.text.trim());

/** Index where the verbatim tail starts: the KEEP_TURNS-th newest turn. 0 means there is nothing older to fold. */
export function tailStart(h: AiMsg[], keep = KEEP_TURNS): number {
  const starts: number[] = [];
  h.forEach((m, i) => { if (startsTurn(m)) starts.push(i); });
  return starts.length > keep ? starts[starts.length - keep] : 0;
}

/** Shorten long tool output in everything before the tail. Returns the new history and the tokens saved. */
export function trimOutputs(h: AiMsg[], keep = KEEP_TURNS): { history: AiMsg[]; saved: number } {
  const cut = tailStart(h, keep) || Math.max(0, h.length - 4);
  const before = historyTokens(h);
  const history = h.map((m, i) => i >= cut ? m : {
    ...m,
    content: m.content.map((p): AiPart => p.type === "tool_result" && p.content.length > 500
      ? { ...p, content: `${p.content.slice(0, 300)}\n…[${p.content.length - 300} more characters trimmed to save context]` } : p),
  });
  return { history, saved: Math.max(0, before - historyTokens(history)) };
}

/** Drop the oldest turns until the tail is all that is left (the "trim" mode). */
export function dropOldest(h: AiMsg[], target: number, overhead: number, keep = KEEP_TURNS): AiMsg[] {
  let out = h;
  for (;;) {
    if (historyTokens(out) + overhead <= target) return out;
    const next = out.findIndex((m, i) => i > 0 && startsTurn(m));
    if (next < 0 || tailStart(out, keep) === 0 || next >= tailStart(out, keep)) return out;
    out = out.slice(next);
  }
}

/** A plain-text transcript of older messages for the summarizer (long outputs shortened, capped overall). */
export function transcript(h: AiMsg[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of h) {
    for (const p of m.content) {
      if (p.type === "text") { if (p.text.trim()) lines.push(`${m.role === "user" ? "USER" : "ASSISTANT"}: ${p.text.trim()}`); }
      else if (p.type === "tool_use") lines.push(`TOOL CALL ${p.name}: ${JSON.stringify(p.input ?? {}).slice(0, 600)}`);
      else lines.push(`TOOL RESULT${p.isError ? " (error)" : ""}: ${p.content.length > 900 ? `${p.content.slice(0, 600)} …[${p.content.length - 600} more chars]` : p.content}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars / 2)}\n…[middle of the conversation omitted]…\n${text.slice(-maxChars / 2)}`;
  return text;
}

export const SUMMARY_SYSTEM = `You compress an earlier part of a DevOps chat (a user and an assistant that runs commands on servers) into notes the assistant will use to continue the work. Write plain text with short bullet lists, at most 350 words, in the language the user used. Keep: what the user wants and any constraints; the hosts involved (names and ids); concrete findings (numbers, paths, versions, error messages); the commands that mattered and what they showed; changes already made (what, where, which backups); decisions; and open questions or next steps. Drop greetings and raw output. Do not invent anything.`;

/** The history with everything before `cut` replaced by `summary`, carried at the top of the first kept message. */
export function withSummary(h: AiMsg[], cut: number, summary: string): AiMsg[] {
  const first = h[cut];
  const note: AiPart = { type: "text", text: `${SUMMARY_TAG}\n${summary.trim()}\n[End of summary. The conversation continues below.]` };
  return [{ ...first, content: [note, ...first.content.filter((p) => !(p.type === "text" && p.text.startsWith(SUMMARY_TAG)))] }, ...h.slice(cut + 1)];
}

export const summaryOf = (m: AiMsg): string | null => {
  const p = m.content.find((x) => x.type === "text" && x.text.startsWith(SUMMARY_TAG)) as { text: string } | undefined;
  return p ? p.text.slice(SUMMARY_TAG.length).replace(/\n?\[End of summary\.[^\]]*\]\s*$/, "").trim() : null;
};
export const withoutSummary = (m: AiMsg): AiMsg => ({ ...m, content: m.content.filter((p) => !(p.type === "text" && p.text.startsWith(SUMMARY_TAG))) });
