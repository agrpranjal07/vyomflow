import { IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

/**
 * Floating "jump to latest" affordance shown while the user has scrolled
 * away from the bottom of a long/streaming chat (message-list.tsx owns the
 * near-bottom detection). Sticks to the bottom of the message scroll area,
 * just above the composer.
 */
export function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    // `mx-auto` directly on the sticky-positioned button rendered it flush
    // against the left edge instead of centered — a `position: sticky` flex
    // item's auto-margin centering is unreliable across browsers. A
    // dedicated `flex justify-center` wrapper (not itself sticky/offset)
    // centers it unambiguously; the sticky positioning stays on the button
    // so only it, not the wrapper, pins to the scroll area's bottom.
    <div className="sticky bottom-2 z-10 flex justify-center">
      <Button
        variant="secondary"
        size="icon"
        onClick={onClick}
        aria-label="Scroll to latest message"
        className="rounded-[var(--radius-pill)] shadow-md"
      >
        <IconChevronDown className="size-4" />
      </Button>
    </div>
  );
}
