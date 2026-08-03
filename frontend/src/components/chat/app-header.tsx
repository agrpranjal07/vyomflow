"use client";

import { IconMenu2 } from "@tabler/icons-react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/chat/model-selector";
import { CreditsIndicator } from "@/components/chat/credits-indicator";
import { useUiStore } from "@/stores/ui";

/** Persistent app-shell header (~56px, --layout-header-height) — model identity + mobile drawer toggle. */
export function AppHeader() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { isSignedIn } = useAuth();
  const { openSignIn, openSignUp } = useClerk();
  const pathname = usePathname();
  // Confirmed live (credits.md "/usage full dashboard"): the reference never
  // shows the header credits pill on its own usage dashboard.
  const showCreditsPill = isSignedIn && pathname !== "/usage";

  return (
    <header className="flex h-[var(--layout-header-height)] shrink-0 items-center gap-2 px-3">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={toggleSidebar} aria-label="Open sidebar">
        <IconMenu2 size={18} />
      </Button>
      <ModelSelector />
      {showCreditsPill && (
        <div className="ml-auto">
          <CreditsIndicator />
        </div>
      )}
      {isSignedIn === false && (
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => openSignIn()}>
            Sign in
          </Button>
          <Button size="sm" onClick={() => openSignUp()}>
            Sign up
          </Button>
        </div>
      )}
    </header>
  );
}
