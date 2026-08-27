"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCredits } from "@/hooks/use-credits";
import { formatCredits } from "@/lib/format";

export type CreditPaywallReason = "message" | "tool" | "upload";

// Mirrors backend/src/lib/config.ts's CREDIT_STARTING_BALANCE — every new
// account starts here. Not wired through the API today (getCredits only
// returns the current balance/held/available), so this is a fixed copy
// rather than a live-fetched value; update both if the grant ever changes.
const NEW_ACCOUNT_STARTING_BALANCE = 100;

const REASON_COPY: Record<CreditPaywallReason, string> = {
  message: "You're out of credits, so this message couldn't be sent.",
  tool: "You're out of credits, so this step couldn't run.",
  upload: "You're out of credits, so this file couldn't be uploaded.",
};

/**
 * Blocking, reusable paywall shown wherever a request fails with
 * INSUFFICIENT_CREDITS (send-turn, mid-turn tool reservation, upload).
 * Deliberately built from the app's own dialog/button/token system
 * (ui-architecture-policy.md) rather than a one-off styled surface.
 */
export function CreditPaywallDialog({
  open,
  reason,
  onOpenChange,
}: {
  open: boolean;
  reason: CreditPaywallReason | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { signOut } = useClerk();
  const { data } = useCredits();

  function handleSwitchAccount() {
    void signOut({ redirectUrl: "/sign-in" });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Out of credits</DialogTitle>
          <DialogDescription>
            {reason && <>{REASON_COPY[reason]} </>}
            Your available balance is {formatCredits(Number(data?.available ?? 0))}. Sign in with
            another ID to get {NEW_ACCOUNT_STARTING_BALANCE} more units (
            {formatCredits(NEW_ACCOUNT_STARTING_BALANCE)} credits) on a fresh account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/usage" onClick={() => onOpenChange(false)} />}
          >
            View usage
          </Button>
          <Button onClick={handleSwitchAccount}>Sign in with another ID</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
