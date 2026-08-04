import { useState } from "react";
import {
  IconChevronDown,
  IconCrop,
  IconMusic,
  IconPhoto,
  IconScissors,
  IconSparkles,
  IconTool,
  IconVideo,
} from "@tabler/icons-react";
import { CircleCheck, CircleX, Clock, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolInvocationStatus } from "@/contracts/tools";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME } from "@/contracts/skills";
import { GeneratedAssetList, classifyAssetUrl } from "@/components/chat/generated-asset";
import { formatCredits } from "@/lib/format";

/**
 * Inline tool-call card — collapsible, one per ToolInvocation. Fed either
 * from a persisted tool_use/tool_result block pair (message-content.tsx —
 * full sanitized `input`) or a live `type:"tool"` stream part
 * (streaming-message.tsx — name/status/credits/output only, no `input`: the
 * wire contract doesn't carry it).
 */
// Labels and icons: "AI Generation" + sparkle glyph for generate_image, not
// a generic "Image generation" + photo icon.
// load_skill/read_skill_asset both render as the reference's generic "Skill"
// step (skill-step.tsx), never as this full ToolCard — see that file. These
// entries exist only as a defensive fallback (label/icon still correct if a
// skill tool_use/tool_result ever reaches ToolCard directly, e.g. a future
// caller that forgets the skill-step branch).
const TOOL_LABELS: Record<string, string> = {
  crop_image: "Image crop",
  generate_image: "AI Generation",
  merge_videos: "Video merge",
  [LOAD_SKILL_TOOL_NAME]: "Skill",
  [READ_SKILL_ASSET_TOOL_NAME]: "Skill",
};

const TOOL_ICONS: Record<string, typeof IconTool | typeof Zap> = {
  crop_image: IconCrop,
  generate_image: IconSparkles,
  merge_videos: IconScissors,
  [LOAD_SKILL_TOOL_NAME]: Zap,
  [READ_SKILL_ASSET_TOOL_NAME]: Zap,
};

// Reference tints its icon per tool (blue for video, pink for AI generation);
// crop_image's icon is untinted (plain secondary-text color) in the
// reference, so it's simply absent from this map. Skill's icon is
// warning-toned (text-text-warning) — reference DOM capture
// (.claude/state/reference-evidence/skill-loading-step.md): `class="lucide
// lucide-zap h-5 w-5 text-text-warning"`, and this codebase already defines
// the identical `--color-text-warning` token (globals.css).
const TOOL_ICON_TINTS: Record<string, string> = {
  generate_image: "text-pink-500",
  merge_videos: "text-blue-500",
  [LOAD_SKILL_TOOL_NAME]: "text-text-warning",
  [READ_SKILL_ASSET_TOOL_NAME]: "text-text-warning",
};

const OUTPUT_KIND_ICONS = { video: IconVideo, audio: IconMusic, image: IconPhoto } as const;

// Exported for skill-step.tsx's reuse — same running/duration semantics,
// not a duplicated copy (ui-architecture-policy.md: no duplicated behavior).
export const RUNNING_STATUSES: ReadonlySet<ToolInvocationStatus> = new Set(["DISPATCHING", "QUEUED", "RUNNING"]);

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return "0ms";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Sanitized input rendered as a two-column key/value table — never the raw model input, always the persisted/validated snapshot (assignment §9 "sanitized tool inputs"). */
function InputTable({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="col-span-2 grid grid-cols-subgrid items-start">
          <dt className="text-text-secondary">{key}</dt>
          <dd className="break-words text-text-primary">
            {typeof value === "string" && /^https?:\/\//.test(value) ? (
              <GeneratedAssetList urls={[value]} />
            ) : typeof value === "object" && value !== null ? (
              JSON.stringify(value)
            ) : (
              String(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ToolCardData {
  name: string;
  status?: ToolInvocationStatus;
  input?: Record<string, unknown>;
  durationMs?: number | null;
  creditUsed?: number | null;
  resultUrls?: string[] | null;
  errorMessage?: string | null;
  /**
   * Whether the whole turn/message this card belongs to has fully settled
   * (every tool_result reached a terminal status and final text follows).
   * Only then should a COMPLETED card auto-collapse; defaults to false
   * (not settled) so cards stay open unless a caller explicitly says the
   * turn is done — see message-content.tsx/streaming-message.tsx.
   */
  turnSettled?: boolean;
}

export function ToolCard({
  name,
  status,
  input,
  durationMs,
  creditUsed,
  resultUrls,
  errorMessage,
  turnSettled = false,
}: ToolCardData) {
  const isRunning = status ? RUNNING_STATUSES.has(status) : true;
  const isFailed = status === "FAILED" || status === "CANCELLED";
  const isCompleted = status === "COMPLETED";
  const ToolIcon = TOOL_ICONS[name] ?? IconTool;
  const label = TOOL_LABELS[name] ?? name;
  // Small badge next to the status icon showing the output's media kind —
  // reference shows a film-strip icon on Video merge, a photo icon on AI
  // Generation, etc. Derived from the first result URL rather than the tool
  // name, since a tool's actual output kind is what the badge means.
  const outputKind = isCompleted ? classifyAssetUrl(resultUrls?.[0] ?? "") : null;
  const OutputKindIcon = outputKind ? OUTPUT_KIND_ICONS[outputKind] : null;

  // null = user hasn't manually toggled yet; once set, it wins over status
  // changes until the component unmounts (a user's manual collapse must
  // persist regardless of subsequent status transitions).
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  // Failed/cancelled cards always stay open for visibility; completed cards
  // only collapse once the whole turn has settled; running (or unknown-
  // status) cards default open.
  const defaultOpen = !(turnSettled && isCompleted);
  const open = manualOverride ?? defaultOpen;

  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    setManualOverride(e.currentTarget.open);
  }

  return (
    <details
      className="my-2 w-full max-w-md overflow-hidden rounded-[var(--radius-md)] border border-border bg-card text-sm text-card-foreground"
      open={open}
      onToggle={handleToggle}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 select-none">
        <ToolIcon className={cn("size-4 shrink-0", TOOL_ICON_TINTS[name] ?? "text-text-secondary")} />
        <span className="font-medium">{label}</span>
        {isRunning ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-text-information" />
        ) : isFailed ? (
          <CircleX className="size-4 shrink-0 text-text-error" />
        ) : (
          <CircleCheck className="size-4 shrink-0 text-text-success" />
        )}
        {OutputKindIcon && <OutputKindIcon className="size-3.5 shrink-0 text-text-secondary" />}
        {!isRunning && (
          <span className="flex items-center gap-1 text-xs text-text-secondary">
            <Clock className="size-3.5" />
            {formatDuration(durationMs)}
          </span>
        )}
        {/* Credits + chevron are grouped together at the far right (reference
            layout — a wide gap separates the left status cluster from this
            pair), not just the chevron alone. No coin icon here — the
            reference's per-card credits badge is bare text; the coin icon is
            reserved for the message's own summary credits line
            (message-content.tsx). */}
        <span className="ml-auto flex items-center gap-2">
          {isCompleted && <span className="text-xs text-text-secondary">{formatCredits(creditUsed)}</span>}
          {/* State-driven, not `group-open:` — since Part 2 started nesting
              ToolCard inside StepGroup (also a `.group` `<details>`), the CSS
              variant matched whichever ancestor `.group[open]` was closest in
              the selector's own resolution, not necessarily this card's own
              toggle — causing the chevron to track the wrong element's open
              state. Explicit state removes the ambiguity regardless of
              nesting depth. */}
          <IconChevronDown className={cn("size-4 shrink-0 text-text-secondary transition-transform", open && "rotate-180")} />
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <span className="text-text-secondary">Tool</span>
          <span className="text-text-primary">{name}</span>
        </div>
        {input && <InputTable input={input} />}
        {isCompleted && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <span className="text-text-secondary">Credits used</span>
            <span className="text-text-primary">{formatCredits(creditUsed)}</span>
          </div>
        )}
        {resultUrls && resultUrls.length > 0 && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <span className="text-text-secondary">Output</span>
            <GeneratedAssetList urls={resultUrls} />
          </div>
        )}
        {isFailed && errorMessage && (
          <p className={cn("text-xs text-text-error")}>Error: {errorMessage}</p>
        )}
      </div>
    </details>
  );
}
