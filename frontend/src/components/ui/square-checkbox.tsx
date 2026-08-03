"use client";

import { IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * Plain square checkbox — 20x20/4px-radius/2px #dedede border unchecked,
 * filled #171717 + white check when checked — measured live against
 * the reference product's own library group-row checkbox (reused for the Tasks
 * page's bulk-select rows, same chrome).
 */
export function SquareCheckbox({
  checked,
  onClick,
  className,
}: {
  checked: boolean;
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
  className?: string;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e);
        }
      }}
      className={cn(
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border-2 transition-colors",
        checked ? "border-surface-dark bg-surface-dark text-white" : "border-border-secondary bg-transparent text-transparent",
        className,
      )}
    >
      <IconCheck className="size-3" strokeWidth={3} />
    </span>
  );
}
