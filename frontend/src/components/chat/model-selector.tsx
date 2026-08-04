"use client";

import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { LogoMark } from "@/components/brand/logo-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OPENROUTER_FREE_MODEL } from "@/contracts/messages";

// Backend supports exactly one model (contracts/messages.ts OPENROUTER_FREE_MODEL).
// A real dropdown listing that single, already-selected option is more honest than
// a static label pretending there's no choice, and than fake tiers we don't have.
const MODEL_LABEL = "OpenRouter Free";

export function ModelSelector() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            // Filled rounded-rect, no border — screenshot-derived geometry
            // (S-fidelity-ui.md, audit finding #13), not the shadcn pill default.
            className="flex h-[var(--layout-control-height-sm)] items-center gap-1.5 rounded-sm bg-muted px-2.5 text-sm font-medium text-text-primary hover:bg-accent"
          >
            <LogoMark size={16} />
            {MODEL_LABEL}
            <IconChevronDown size={14} className="text-text-secondary" />
          </button>
        }
      />
      <DropdownMenuContent align="start">
        {/* Non-interactive (only one model exists) but must render at full
            contrast as the selected option, not greyed-out — audit finding
            #14. `disabled` drives shadcn's data-disabled:opacity-50, so the
            non-interactivity is expressed via pointer-events instead. */}
        <DropdownMenuItem className="pointer-events-none opacity-100">
          <IconCheck size={16} />
          <div className="flex flex-col">
            <span>{MODEL_LABEL}</span>
            <span className="text-xs text-text-secondary">{OPENROUTER_FREE_MODEL}</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
