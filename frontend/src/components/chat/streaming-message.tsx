import { Fragment, useMemo } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import { MessageContent, ReasonedStep } from "@/components/chat/message-content";
import { ToolCard } from "@/components/chat/tool-card";
import { SkillStep } from "@/components/chat/skill-step";
import { StepGroup } from "@/components/chat/step-group";
import type { ContentBlock } from "@/contracts/common";
import type { LiveToolState, StreamedSegment } from "@/lib/run-status";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME } from "@/contracts/skills";

// load_skill/read_skill_asset render as the reference's plain "Skill" step
// (skill-step.tsx), never the full ToolCard chrome — see message-content.tsx.
const SKILL_TOOL_NAMES = new Set<string>([LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME]);

export type { LiveToolState };

/**
 * The live assistant bubble for the chat's currently-active run — sources
 * text from useActiveRun's accumulated stream parts, not a persisted
 * MessageDTO. MessageList swaps this in for the active run's assistant
 * message and swaps it back out (to the normal MessageBubble, reading the
 * now-persisted final text) once the run reaches a terminal state. Styled
 * to match MessageBubble's plain (no-card) assistant treatment so settling
 * from streaming to persisted never visibly jumps
 * (.claude/evidence/reference-chat-response-rendered.md).
 */
export function StreamingMessage({
  text,
  tools,
  segments,
  isThinking,
}: {
  text: string;
  /** Live tool-call state accumulated from `type:"tool"` stream parts (D1) — rendered inline, same as a persisted tool_use/tool_result pair once the turn settles. */
  tools?: LiveToolState[];
  /**
   * True chronological interleave of text/tool arrival (run-status.ts
   * buildStreamedSegments) — renders text and tool cards in real order
   * instead of all text then all tools. Falls back to the flat `text`/
   * `tools` rendering below when absent (e.g. a caller/test that hasn't
   * been updated to compute it).
   */
  segments?: StreamedSegment[];
  /**
   * Run has started but genuinely NOTHING has arrived yet — no streamed
   * text AND no tool call either — chevron + "Thinking" + spinner shell
   * (S-fidelity-ui.md, chat--streaming-thinking--desktop.png). Computed by
   * the caller as `!streamedText && !streamedTools?.length`: a tool-first
   * round (model calls a tool before any prose, the normal case for e.g.
   * "generate an image") must not stay on this shell just because text is
   * still empty — the backend already writes the tool's DISPATCHING stream
   * part immediately, so a card should appear the moment a tool is called,
   * not wait for the first text token of a later round to unmask it.
   */
  isThinking?: boolean;
}) {
  // Stable identities across re-renders that don't actually change `text`/
  // `tools` — audit finding M2: passing fresh inline array literals here on
  // every render defeated MessageContent's own useMemo (which keys on these
  // exact references), so its markdown `components` object got a new
  // identity on every streamed token, and react-markdown remounted the
  // whole inline-media subtree (flicker, repeated image requests, GeneratedAsset's
  // error-fallback state reset before it could ever latch).
  const blocks = useMemo<ContentBlock[]>(() => [{ type: "text", text }], [text]);
  const knownAssetUrls = useMemo(() => tools?.flatMap((t) => t.resultUrls ?? []), [tools]);

  // Transport health (reconnecting/connection-lost) is never surfaced here —
  // the reference product shows no visible reconnect/error UI at all
  // (.claude/evidence/chat.md network-blocking test); the underlying
  // reconnect mechanism in use-active-run.ts keeps working invisibly and
  // still resolves the run via `finalize()` once it actually completes.
  return (
    <div className="flex w-full justify-start">
      {/* Horizontal inset comes from MessageList's own p-4 alone — matches
          MessageBubble's assistant column (audit finding #16). */}
      <div className="w-full text-sm">
        {isThinking ? (
          <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-text-secondary">
            <IconChevronDown className="size-4" />
            <span>Thinking</span>
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : segments ? (
          <>
            {(() => {
              // Same "group consecutive step nodes under one StepGroup"
              // treatment as the persisted path (message-content.tsx) — live
              // parity, so settling never visually re-groups (audit finding
              // M1). Reasoning and tool segments are both steps; text is not.
              type Node = { key: string; node: React.ReactNode; isStep: boolean };
              const nodes: Node[] = segments.map((segment, i) => {
                if (segment.type === "text") {
                  return {
                    key: `seg-text-${i}`,
                    isStep: false,
                    node: (
                      <MessageContent
                        blocks={[{ type: "text", text: segment.text }]}
                        knownAssetUrls={knownAssetUrls}
                      />
                    ),
                  };
                }
                if (segment.type === "reasoning") {
                  return { key: `seg-reasoning-${i}`, isStep: true, node: <ReasonedStep text={segment.text} /> };
                }
                return {
                  key: `seg-tool-${segment.tool.toolInvocationId}`,
                  isStep: true,
                  node: SKILL_TOOL_NAMES.has(segment.tool.name) ? (
                    <SkillStep status={segment.tool.status} durationMs={segment.tool.durationMs} />
                  ) : (
                    <ToolCard
                      name={segment.tool.name}
                      status={segment.tool.status}
                      durationMs={segment.tool.durationMs}
                      creditUsed={segment.tool.creditUsed}
                      resultUrls={segment.tool.resultUrls}
                      errorMessage={segment.tool.errorMessage}
                      turnSettled={false}
                    />
                  ),
                };
              });

              const rendered: { key: string; node: React.ReactNode }[] = [];
              let stepRun: Node[] = [];
              const flushSteps = () => {
                if (stepRun.length === 0) return;
                const run = stepRun;
                stepRun = [];
                rendered.push({
                  key: `steps-${run[0].key}`,
                  node: (
                    <StepGroup stepCount={run.length} settled={false}>
                      {run.map((n) => (
                        <Fragment key={n.key}>{n.node}</Fragment>
                      ))}
                    </StepGroup>
                  ),
                });
              };
              for (const n of nodes) {
                if (n.isStep) stepRun.push(n);
                else {
                  flushSteps();
                  rendered.push({ key: n.key, node: n.node });
                }
              }
              flushSteps();
              return rendered.map((r) => <Fragment key={r.key}>{r.node}</Fragment>);
            })()}
          </>
        ) : (
          // Fallback for a caller that hasn't supplied `segments` yet — same
          // flat "all text, then all tools" rendering as before.
          <>
            <MessageContent blocks={blocks} knownAssetUrls={knownAssetUrls} />
            {tools?.map((tool) =>
              SKILL_TOOL_NAMES.has(tool.name) ? (
                <SkillStep key={tool.toolInvocationId} status={tool.status} durationMs={tool.durationMs} />
              ) : (
                <ToolCard
                  key={tool.toolInvocationId}
                  name={tool.name}
                  status={tool.status}
                  durationMs={tool.durationMs}
                  creditUsed={tool.creditUsed}
                  resultUrls={tool.resultUrls}
                  errorMessage={tool.errorMessage}
                  turnSettled={false}
                />
              ),
            )}
          </>
        )}
      </div>
    </div>
  );
}
