"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CreditPaywallDialog, type CreditPaywallReason } from "@/components/credits/credit-paywall-dialog";

type PaywallContextValue = {
  open: (reason: CreditPaywallReason) => void;
};

const PaywallContext = createContext<PaywallContextValue | null>(null);

/**
 * One paywall dialog instance for the whole chat shell, opened from any of
 * the three INSUFFICIENT_CREDITS call sites (send-turn, tool orchestration,
 * upload). `openedForRun` de-dupes repeated tool-failure events within the
 * same run so a run with several credit-exhausted tool calls doesn't stack
 * re-opens.
 */
export function CreditPaywallProvider({ children }: { children: React.ReactNode }) {
  const [reason, setReason] = useState<CreditPaywallReason | null>(null);
  const openedRef = useRef(false);

  const open = useCallback((next: CreditPaywallReason) => {
    if (openedRef.current) return;
    openedRef.current = true;
    setReason(next);
  }, []);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setReason(null);
      openedRef.current = false;
    }
  }

  return (
    <PaywallContext.Provider value={{ open }}>
      {children}
      <CreditPaywallDialog open={reason !== null} reason={reason} onOpenChange={handleOpenChange} />
    </PaywallContext.Provider>
  );
}

export function useCreditPaywall(): PaywallContextValue {
  const ctx = useContext(PaywallContext);
  if (!ctx) throw new Error("useCreditPaywall must be used within CreditPaywallProvider");
  return ctx;
}
