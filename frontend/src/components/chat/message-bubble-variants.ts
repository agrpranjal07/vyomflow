import { cva } from "class-variance-authority";

// Shared bubble geometry (S-fidelity-ui.md §2.3/2.4: radius-md 16px,
// padding 6px/16px, user bubble max-width 448px). Single source so
// message-bubble.tsx and streaming-message.tsx don't each hardcode the
// same three literals (ui-architecture-policy.md).
export const bubbleVariants = cva("rounded-[var(--radius-md)] px-4 py-1.5", {
  variants: {
    tone: {
      user: "max-w-[var(--layout-message-max-width)] bg-bubble-user-bg text-bubble-user-fg",
      error: "w-full border border-destructive/50",
    },
  },
});
