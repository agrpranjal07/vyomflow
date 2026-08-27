"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiClient } from "@/hooks/use-api-client";
import { createApiKey, type CreateApiKeyResponse } from "@/services/api-keys";
import { ApiError } from "@/lib/api-client";

/**
 * Create flow for self-serve public-API keys. Goes through our own
 * `/api/v1/api-keys` (backend-mediated, Clerk Backend API) rather than
 * Clerk's client-side `clerk.apiKeys.create` (Frontend API) — the latter
 * can never attach scopes, which made every previously self-minted key
 * 403 on every scope-gated public route. Listing/revocation stay on
 * Clerk's own `useAPIKeys()`/`clerk.apiKeys.revoke` (scope-agnostic,
 * unaffected by this bug) — see settings/api-keys/page.tsx.
 */
export function CreateApiKeyDialog({ onCreated }: { onCreated: () => void }) {
  const fetcher = useApiClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setError(null);
    setCreated(null);
    setCopied(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await createApiKey(fetcher, { name: name.trim() });
      setCreated(result);
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to create API key.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!created) return;
    await navigator.clipboard.writeText(created.secret);
    setCopied(true);
  }

  function handleCloseAndReset() {
    setOpen(false);
    reset();
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create API Key</Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Copy your &ldquo;{created.name}&rdquo; API Key now
                </DialogTitle>
                <DialogDescription>
                  For security reasons, we won&rsquo;t allow you to view it
                  again later.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={created.secret}
                  className="font-mono text-xs"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCopy}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button onClick={handleCloseAndReset}>Copy & Close</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Create API Key</DialogTitle>
                <DialogDescription>
                  Name your key so you can identify it later.
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My integration"
                className="mt-4"
              />
              {error && (
                <p className="mt-2 text-sm text-destructive">{error}</p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting || !name.trim()}>
                  {isSubmitting ? "Creating…" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
