import type { ReactNode } from "react";

// @base-ui/react's Dialog primitive isn't safely renderable in this
// workspace's RTL environment — same class of problem documented for
// Popover in credits-indicator.test.tsx (only installed under
// frontend/node_modules, a separate React resolution tree). Minimal
// open/close stand-in, shared across tests that render a component built
// on components/ui/dialog.tsx, preserving only the open/onOpenChange
// contract those components actually rely on.
export function Dialog({
  open,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return open ? <>{children}</> : null;
}
export function DialogContent({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
export function DialogHeader({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
export function DialogTitle({ children }: { children: ReactNode }) {
  return <h2>{children}</h2>;
}
export function DialogDescription({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}
