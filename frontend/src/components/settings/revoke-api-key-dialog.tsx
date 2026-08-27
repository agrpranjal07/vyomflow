"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Themed confirmation for revoking an API key — replaces a native
 * `confirm()`, which triggers a real blocking browser dialog and is
 * disallowed for automation/testing (and doesn't match the app's theme).
 */
export function RevokeApiKeyDialog({
  apiKeyName,
  onConfirm,
  children,
}: {
  apiKeyName: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={children as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke &ldquo;{apiKeyName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This can&rsquo;t be undone. Any requests using this key will stop working immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
