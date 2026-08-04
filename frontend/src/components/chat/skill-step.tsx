import { CircleCheck, Clock, Loader2, Zap } from "lucide-react";
import type { ToolInvocationStatus } from "@/contracts/tools";
import { RUNNING_STATUSES, formatDuration } from "@/components/chat/tool-card";

/**
 * The reference's "Skill" step (load_skill / read_skill_asset tool calls) —
 * DOM/computed-style capture:
 * .claude/state/reference-evidence/skill-loading-step.md. Deliberately NOT
 * a ToolCard: the reference row has no chevron, no expand/collapse, no
 * input table, no output body, no skill-name/content preview beyond the
 * literal label "Skill" — just icon + label + status + duration, matching
 * the flat step-list row style also used by ReasonedStep
 * (message-content.tsx). The "why a skill was consulted" text is a
 * separate, adjacent "Reasoned" step per the reference, not part of this
 * component.
 *
 * Icon: Lucide `zap` in the reference (`text-text-warning`) — this codebase
 * uses the Lucide `Zap` icon directly (tool-status/step-list icon
 * subsystem — see tool-card.tsx), with the same `text-text-warning` token
 * the reference itself resolves to (already defined in globals.css, not
 * invented here).
 *
 * Pending/loading icon state was explicitly UNKNOWN in the reference
 * capture (both observed instances were already completed) — this reuses
 * ToolCard's own RUNNING-status spinner convention (Loader2 + animate-spin)
 * rather than guessing at a reference-specific transition; that is a project
 * convention, not reference fidelity.
 */
export function SkillStep({
  status,
  durationMs,
}: {
  status?: ToolInvocationStatus;
  durationMs?: number | null;
}) {
  const isRunning = status ? RUNNING_STATUSES.has(status) : true;
  return (
    <div className="flex w-full items-center gap-1.5 py-1 text-sm">
      <Zap className="size-3.5 shrink-0 text-text-warning" />
      <span className="font-medium text-text-primary">Skill</span>
      {isRunning ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-text-information" />
      ) : (
        <CircleCheck className="size-3 shrink-0 text-text-success" />
      )}
      {!isRunning && (
        <span className="flex items-center gap-1 text-xs text-text-secondary">
          <Clock className="size-3" />
          {formatDuration(durationMs)}
        </span>
      )}
    </div>
  );
}
