"use client";

import { useState } from "react";
import { IconAlertTriangle, IconHelpCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WaitpointDTO, RespondToWaitpointRequest } from "@/contracts/waitpoints";

/**
 * In-flow approval/clarification prompt for a run's `pendingWaitpoint`
 * (S6-reliability-implementation-plan.md §7.8). Renders above the composer,
 * not as a modal — the assignment's "Options, plan, credit, or media
 * approval" wording frames this as part of the conversation, and no
 * reference screenshot exists for either waitpoint kind to say otherwise
 * (§2.7 of the plan — UNKNOWN, not silently guessed: mark for a future
 * fidelity pass rather than a modal invented without evidence).
 *
 * Renders nothing when there's no PENDING waitpoint — callers don't need to
 * guard on that themselves.
 */
export function ApprovalOverlay({
  waitpoint,
  onRespond,
}: {
  waitpoint: WaitpointDTO | null;
  onRespond: (waitpointId: string, body: RespondToWaitpointRequest) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  if (!waitpoint || waitpoint.status !== "PENDING") return null;

  async function submit(body: RespondToWaitpointRequest) {
    setPending(true);
    setError(null);
    try {
      await onRespond(waitpoint!.id, body);
      setPending(false);
    } catch {
      // Matches this codebase's existing service error-handling convention
      // (ApiError is thrown, caller shows a generic retry-worthy message —
      // see page.tsx's handleStop/handleRetry) rather than parsing the
      // error's shape here.
      setError("Couldn't send your response — try again.");
      setPending(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={waitpoint.kind === "CREDIT_APPROVAL" ? "Credit approval requested" : "Clarification requested"}
      className="mx-auto flex w-full max-w-[var(--layout-chat-content-width)] flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-card px-4 py-3 text-sm text-card-foreground"
    >
      {waitpoint.kind === "CREDIT_APPROVAL" ? (
        <CreditApproval
          requestPayload={waitpoint.requestPayload}
          pending={pending}
          onApprove={() => submit({ kind: "CREDIT_APPROVAL", approved: true })}
          onDecline={() => submit({ kind: "CREDIT_APPROVAL", approved: false })}
        />
      ) : (
        <Clarification
          requestPayload={waitpoint.requestPayload}
          pending={pending}
          answer={answer}
          onAnswerChange={setAnswer}
          onSubmit={(value) => submit({ kind: "CLARIFICATION", answer: value })}
        />
      )}
      {error && <p className="text-xs text-text-error">{error}</p>}
    </div>
  );
}

function CreditApproval({
  requestPayload,
  pending,
  onApprove,
  onDecline,
}: {
  requestPayload: { toolName: string; estimatedCredits: number; threshold: number };
  pending: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { toolName, estimatedCredits, threshold } = requestPayload;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        <IconAlertTriangle className="size-4 shrink-0 text-text-warning" />
        {/* Copy pattern per plan §6.2a — substituted verbatim, not paraphrased. */}
        This step ({toolName}) will use ~{estimatedCredits}M credits (threshold {threshold}M) — continue?
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={onDecline}>
          Decline
        </Button>
        <Button size="sm" disabled={pending} onClick={onApprove}>
          Approve
        </Button>
      </span>
    </div>
  );
}

function Clarification({
  requestPayload,
  pending,
  answer,
  onAnswerChange,
  onSubmit,
}: {
  requestPayload: { question: string; options?: string[] };
  pending: boolean;
  answer: string;
  onAnswerChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const { question, options } = requestPayload;
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2">
        <IconHelpCircle className="size-4 shrink-0 text-text-information" />
        {/* Model output rendered as plain text content — never dangerouslySetInnerHTML — React escapes this by default. */}
        {question}
      </span>
      {options && options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button key={option} size="sm" variant="outline" disabled={pending} onClick={() => onSubmit(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={answer}
            onChange={(e) => onAnswerChange(e.target.value)}
            disabled={pending}
            placeholder="Your answer…"
            aria-label="Answer"
            onKeyDown={(e) => {
              if (e.key === "Enter" && answer.trim()) onSubmit(answer.trim());
            }}
          />
          <Button size="sm" disabled={pending || !answer.trim()} onClick={() => onSubmit(answer.trim())}>
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
