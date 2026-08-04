import { useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * Wraps a run of consecutive non-text step nodes (reasoning + tool calls)
 * under one collapsible "Working · N steps" / "Completed N steps" header —
 * reference-verified copy and behavior, not guessed
 * (.claude/evidence/chat.md:191,203,214,225,239,339: "Working · N steps"
 * while a run is active, "Completed N steps" once it settles, including the
 * singular "Completed 1 step" for a short turn). `stepCount` is the number
 * of steps we genuinely performed (tool calls + reasoning steps) — never
 * padded to match the reference's own step counts, which include
 * reference-internal phases (Skill, Model schema) this app doesn't yet produce (see
 * jaunty-cooking-lark.md's honesty constraint).
 */
export function StepGroup({
  stepCount,
  settled,
  children,
}: {
  stepCount: number;
  /** Whether this group's steps have all finished (renders "Completed" vs "Working"). */
  settled: boolean;
  children: React.ReactNode;
}) {
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const open = manualOverride ?? !settled;
  // Exact reference copy (.claude/evidence/chat.md): "Working · N steps"
  // while active, "Completed N steps" (no middot) once settled.
  const stepWord = stepCount === 1 ? "step" : "steps";
  const label = settled ? `Completed ${stepCount} ${stepWord}` : `Working · ${stepCount} ${stepWord}`;

  return (
    <details
      className="my-2 w-full max-w-md"
      open={open}
      onToggle={(e) => setManualOverride(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm text-text-secondary select-none">
        {/* State-driven, not `group-open:` — see message-content.tsx's
            ReasonedStep for why (the CSS variant wasn't actually toggling). */}
        <IconChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        <span>{label}</span>
      </summary>
      <div className="flex flex-col">{children}</div>
    </details>
  );
}
