"use client";

import { useEffect, useRef } from "react";
import { IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "@/components/chat/sidebar";
import { cn } from "@/lib/utils";

/** Off-canvas sidebar for narrow viewports — the desktop layout renders Sidebar inline instead. */
export function MobileSidebarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    triggerRef.current = document.activeElement;
    panelRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open, onClose]);

  return (
    <div className={cn("fixed inset-0 z-50 md:hidden", !open && "pointer-events-none")}>
      <button
        type="button"
        aria-label="Close sidebar"
        // Reference's own scrim color wasn't measured — token-relative dim, not a hardcoded hex.
        className={cn(
          "absolute inset-0 bg-foreground/20 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        className={cn(
          "absolute inset-y-0 left-0 w-[var(--layout-sidebar-width)] shadow-lg outline-none transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {open && <Sidebar forceExpanded />}
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 text-sidebar-foreground"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <IconX size={18} />
        </Button>
      </div>
    </div>
  );
}
