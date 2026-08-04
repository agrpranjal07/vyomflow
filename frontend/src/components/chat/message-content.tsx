import { Fragment, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconBrain, IconChevronDown, IconCoin } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { ContentBlock } from "@/contracts/common";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME } from "@/contracts/skills";
import { ToolCard } from "@/components/chat/tool-card";
import { SkillStep } from "@/components/chat/skill-step";
import { GeneratedAsset, classifyAssetUrl } from "@/components/chat/generated-asset";
import { StepGroup } from "@/components/chat/step-group";
import { formatCredits } from "@/lib/format";

const TERMINAL_TOOL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
// load_skill/read_skill_asset render as the reference's plain "Skill" step
// (skill-step.tsx), never the full ToolCard chrome — see that file.
const SKILL_TOOL_NAMES = new Set<string>([LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME]);

/** A reasoning/thinking block's collapsible "Reasoned" step — reference label (.claude/evidence/chat.md:192). Both block types render identically: `thinking` is a hypothetical future producer, `reasoning` is what the backend actually emits today (see jaunty-cooking-lark.md Part 1). Exported for streaming-message.tsx's live path, so a reasoning delta gets the same collapsible treatment while streaming as it does once persisted. */
export function ReasonedStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="my-1" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm text-text-secondary select-none">
        {/* Tied directly to `open` state rather than a `group-open:` CSS
            variant — that variant depends on Tailwind matching `<details
            [open]>` via the ancestor `.group` selector, which wasn't
            actually flipping the rotation (the chevron pointed the same
            direction whether collapsed or expanded). Explicit state is
            unambiguous. */}
        <IconChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        {/* Brain icon + italic label — reference-verified glyph/style
            (.claude/evidence/chat.md tool-card captures). */}
        <IconBrain className="size-3.5 shrink-0" />
        <span className="italic">Reasoned</span>
      </summary>
      <p className="py-1 pl-5 text-sm whitespace-pre-wrap text-text-secondary">{text}</p>
    </details>
  );
}

const proseClassName = cn(
  "prose prose-sm max-w-none break-words",
  // Paragraph rhythm ~20px (screenshot-inferred, not DOM-measured — S-fidelity-ui.md §9).
  // line-height 20px measured for message body (S-fidelity-ui.md §2.1) —
  // Typography's prose-sm default (24px) overrides the inherited body
  // leading, so it's pinned back explicitly here.
  "prose-p:my-3 prose-p:first:mt-0 prose-p:last:mb-0 prose-p:leading-5 leading-5",
  "prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-ol:pl-6 prose-li:my-0.5",
  "prose-strong:font-bold",
  "prose-pre:my-2 prose-pre:bg-background/40",
  // The user bubble is a light surface (S-fidelity-ui.md §2.2) — it must
  // read with the same neutral (dark-text) prose treatment as the
  // assistant, never prose-invert (which assumes a dark surface and
  // renders near-invisible light-gray text here).
  "prose-neutral dark:prose-invert",
  // Defensive-only: CustomImg below always routes a real markdown `![]()`
  // through GeneratedAsset, which already sizes itself — this just bounds
  // anything react-markdown might render outside that path.
  "prose-img:max-h-80 prose-img:w-auto prose-img:max-w-full prose-img:object-contain",
);

/** A genuine markdown `![]()` image gets the same sizing/error-fallback treatment as every other generated asset, instead of an unstyled raw `<img>`. */
const CustomImg: Components["img"] = ({ src }) => (typeof src === "string" ? <GeneratedAsset url={src} /> : null);

/**
 * Renders an ordered content-block array — text as markdown (reference:
 * The reference product's chat page renders assistant responses as formatted markdown —
 * .claude/evidence/reference-chat-response-rendered.md), consecutive
 * step-type blocks (tool_use/tool_result/reasoning/thinking) grouped under
 * one collapsible StepGroup ("Working/Completed N steps" —
 * .claude/evidence/chat.md), and citation/usage rendered too — all in the
 * array's own order (assignment §5: "render text, thinking, tool use, tool
 * result, reasoning, citations, and usage without losing ordering"). Split
 * out from MessageBubble (ui-architecture-policy.md: "message bubble/
 * content renderer" is a named meaningful component boundary).
 */
export function MessageContent({
  blocks,
  knownAssetUrls,
}: {
  blocks: ContentBlock[];
  /**
   * Extra URLs (e.g. a live run's in-flight tool `resultUrls`, from
   * streaming-message.tsx) to treat as known assets even though no sibling
   * `tool_result` block exists yet in `blocks` to derive them from.
   */
  knownAssetUrls?: string[];
}) {
  const toolUseById = new Map(blocks.filter((b) => b.type === "tool_use").map((b) => [b.id, b]));
  const hasResultFor = new Set(blocks.filter((b) => b.type === "tool_result").map((b) => b.toolUseId));

  // Every URL a sibling tool_result already produced in this message, plus
  // any caller-supplied known URLs — lets CustomLink recognize an
  // extensionless/unrecognized-extension asset URL that also appears as a
  // plain markdown link in the assistant's prose (S3 fidelity finding).
  const knownUrls = useMemo(() => {
    const urls = new Set<string>(knownAssetUrls ?? []);
    for (const block of blocks) {
      if (block.type === "tool_result") {
        for (const url of block.resultUrls ?? []) urls.add(url);
      }
    }
    return urls;
  }, [blocks, knownAssetUrls]);

  const markdownComponents: Components = useMemo(() => {
    const CustomLink: Components["a"] = ({ href, children }) => {
      if (href && (knownUrls.has(href) || classifyAssetUrl(href))) {
        return (
          <span className="block">
            <GeneratedAsset url={href} />
          </span>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
          {children}
        </a>
      );
    };
    return { a: CustomLink, img: CustomImg };
  }, [knownUrls]);

  // A turn is settled once every tool_result in it reached a terminal
  // status AND final text follows the last tool-related block — only then
  // should completed tool cards auto-collapse (tool-card.tsx turnSettled).
  const lastToolIndex = (() => {
    let idx = -1;
    blocks.forEach((b, i) => {
      if (b.type === "tool_use" || b.type === "tool_result") idx = i;
    });
    return idx;
  })();
  // Every tool_use must have reached a result AND that result must be
  // terminal — a tool_use with no tool_result yet (still running) must not
  // let an EARLIER, already-terminal tool's card collapse (audit finding
  // M3: `allToolsTerminal` was previously vacuously true whenever a later
  // tool_use had no result block at all, since only tool_result blocks were
  // checked).
  const allToolUseIds = new Set(blocks.filter((b) => b.type === "tool_use").map((b) => b.id));
  const everyToolUseHasResult = [...allToolUseIds].every((id) => hasResultFor.has(id));
  const allToolsTerminal =
    everyToolUseHasResult &&
    blocks.filter((b) => b.type === "tool_result").every((b) => b.status && TERMINAL_TOOL_STATUSES.has(b.status));
  const hasTrailingText =
    lastToolIndex >= 0 &&
    blocks.slice(lastToolIndex + 1).some((b) => b.type === "text" && b.text.trim().length > 0);
  const turnSettled = lastToolIndex >= 0 && allToolsTerminal && hasTrailingText;

  // Sum of every tool's credit spend plus the LLM's own (always 0 on the
  // free-model path — contracts/common.ts) — rendered as the per-message
  // credit line once a trailing `usage` block confirms the message is
  // actually finalized (a live/streaming message never carries one).
  const usageBlock = blocks.find((b): b is Extract<ContentBlock, { type: "usage" }> => b.type === "usage");
  const totalCredits = usageBlock
    ? blocks.reduce((sum, b) => sum + (b.type === "tool_result" ? (b.creditUsed ?? 0) : 0), 0) +
      (usageBlock.costCredits ?? 0)
    : null;

  type Node = { key: string; node: React.ReactNode; isStep: boolean; isUnsettledStep: boolean };
  const nodes: Node[] = [];
  let textBuffer: string[] = [];
  const flushText = (key: string) => {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join("\n\n");
    textBuffer = [];
    nodes.push({
      key,
      isStep: false,
      isUnsettledStep: false,
      node: (
        <div className={proseClassName}>
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {text}
          </Markdown>
        </div>
      ),
    });
  };

  blocks.forEach((block, i) => {
    if (block.type === "text") {
      textBuffer.push(block.text);
      return;
    }
    if (block.type === "reasoning" || block.type === "thinking") {
      flushText(`text-${i}`);
      nodes.push({ key: `reasoning-${i}`, isStep: true, isUnsettledStep: false, node: <ReasonedStep text={block.text} /> });
      return;
    }
    if (block.type === "citation") {
      flushText(`text-${i}`);
      nodes.push({
        key: `citation-${i}`,
        isStep: false,
        isUnsettledStep: false,
        node: (
          <a href={block.url} target="_blank" rel="noopener noreferrer" className="block text-xs text-text-secondary underline">
            {block.title ?? block.url}
          </a>
        ),
      });
      return;
    }
    if (block.type === "usage") return; // consumed above for the credits line, not rendered as its own node
    if (block.type === "tool_result") {
      flushText(`text-${i}`);
      const toolUse = toolUseById.get(block.toolUseId);
      const name = block.name ?? toolUse?.name ?? "tool";
      const isRunning = block.status ? !TERMINAL_TOOL_STATUSES.has(block.status) : true;
      nodes.push({
        key: `tool-${block.toolUseId}`,
        isStep: true,
        isUnsettledStep: isRunning,
        node: SKILL_TOOL_NAMES.has(name) ? (
          <SkillStep status={block.status} durationMs={block.durationMs} />
        ) : (
          <ToolCard
            name={name}
            status={block.status}
            input={toolUse?.input}
            durationMs={block.durationMs}
            creditUsed={block.creditUsed}
            resultUrls={block.resultUrls}
            errorMessage={block.errorMessage}
            turnSettled={turnSettled}
          />
        ),
      });
      return;
    }
    // A tool_use with no paired tool_result yet (mid-run, or a crash before
    // the result landed — D4) still renders, as a pending/running card.
    if (block.type === "tool_use" && !hasResultFor.has(block.id)) {
      flushText(`text-${i}`);
      nodes.push({
        key: `tool-${block.id}`,
        isStep: true,
        isUnsettledStep: true,
        node: SKILL_TOOL_NAMES.has(block.name) ? (
          <SkillStep />
        ) : (
          <ToolCard name={block.name} input={block.input} turnSettled={turnSettled} />
        ),
      });
    }
  });
  flushText("text-tail");

  // Group consecutive step nodes (reasoning + tool calls) under one
  // collapsible StepGroup — the reference's "Working/Completed N steps"
  // header (each node's `isStep` flag above marks which block types count).
  const segments: { key: string; node: React.ReactNode }[] = [];
  let stepRun: Node[] = [];
  const flushSteps = () => {
    if (stepRun.length === 0) return;
    const run = stepRun;
    stepRun = [];
    segments.push({
      key: `steps-${run[0].key}`,
      node: (
        <StepGroup stepCount={run.length} settled={!run.some((n) => n.isUnsettledStep)}>
          {run.map((n) => (
            <Fragment key={n.key}>{n.node}</Fragment>
          ))}
        </StepGroup>
      ),
    });
  };
  for (const n of nodes) {
    if (n.isStep) {
      stepRun.push(n);
    } else {
      flushSteps();
      segments.push({ key: n.key, node: n.node });
    }
  }
  flushSteps();

  if (totalCredits !== null) {
    segments.push({
      key: "credits",
      node: (
        <div className="flex items-center gap-1 pt-1 text-[10px] text-text-secondary">
          <IconCoin className="size-3" />
          {formatCredits(totalCredits)} credits
        </div>
      ),
    });
  }

  return (
    <>
      {segments.map((segment) => (
        <Fragment key={segment.key}>{segment.node}</Fragment>
      ))}
    </>
  );
}
