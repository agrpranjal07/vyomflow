"use client";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog";
import { RevokeApiKeyDialog } from "@/components/settings/revoke-api-key-dialog";

const apiKeysQueryKey = ["apiKeys"] as const;

/**
 * Standalone /settings/api-keys page — lets a signed-in user mint/manage
 * their own Clerk API keys for the public REST/MCP surface (session-token
 * protected like every other page under (chat)/, per proxy.ts).
 *
 * Create goes through our own backend (`CreateApiKeyDialog` -> POST
 * /api/v1/api-keys), never Clerk's `<APIKeys/>` widget / Frontend API:
 * confirmed live that Frontend-API-minted keys carry zero scopes and 403
 * on every public route, since scopes can only be set via the Backend API
 * (Context7 `/clerk/clerk-docs`).
 *
 * Listing goes through TanStack Query (this app's existing server-state
 * convention, see hooks/use-chats.ts) calling `clerk.apiKeys.getAll()`
 * directly, rather than Clerk's own `useAPIKeys()` hook: verified live
 * that the hook never fires its underlying fetch at all on this page
 * (zero network request, `isLoading` settles to `false` with empty
 * `data`) — its internal `isSignedIn` gate reads `clerk.user` once from
 * the non-reactive Clerk client instance, which can still be `null` at
 * that render. Gating the query on `useUser()`'s reactive `isLoaded`
 * avoids the same race. Revocation stays on Clerk's own
 * `clerk.apiKeys.revoke` — scope-agnostic, and a Backend-API-created key
 * is still a normal `api_keys` resource under the same user, so it
 * appears here like any other key.
 */
export default function ApiKeysPage() {
  const clerk = useClerk();
  const { isLoaded: userLoaded } = useUser();
  const queryClient = useQueryClient();

  const { data: apiKeys, isLoading } = useQuery({
    queryKey: apiKeysQueryKey,
    queryFn: async () => (await clerk.apiKeys.getAll()).data,
    enabled: userLoaded,
  });

  const revoke = useMutation({
    mutationFn: (apiKeyId: string) =>
      clerk.apiKeys.revoke({ apiKeyID: apiKeyId, revocationReason: "Revoked by user" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: apiKeysQueryKey }),
  });


  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-[1472px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[30px] font-bold leading-9 text-text-primary">
              API Keys
            </h1>
            <p className="mt-1.5 text-lg leading-7 text-text-secondary">
              Create and manage API keys for the VyomFlow public API and MCP
              server
            </p>
          </div>
          <CreateApiKeyDialog
            onCreated={() => queryClient.invalidateQueries({ queryKey: apiKeysQueryKey })}
          />
        </div>

        <div className="mt-6 overflow-hidden rounded-[var(--radius-lg)] border border-border-hairline">
          {isLoading ? (
            <p className="p-4 text-sm text-text-secondary">Loading…</p>
          ) : !apiKeys || apiKeys.length === 0 ? (
            <p className="p-4 text-sm text-text-secondary">No API keys yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-text-secondary">
                <tr>
                  <th className="p-3 font-medium">Name</th>
                  <th className="p-3 font-medium">Expiration</th>
                  <th className="p-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((apiKey) => (
                  <tr
                    key={apiKey.id}
                    className="border-t border-border-hairline"
                  >
                    <td className="p-3 text-text-primary">{apiKey.name}</td>
                    <td className="p-3 text-text-secondary">
                      {apiKey.expiration
                        ? new Date(apiKey.expiration).toLocaleDateString()
                        : "No expiration"}
                    </td>
                    <td className="p-3 text-right">
                      <RevokeApiKeyDialog
                        apiKeyName={apiKey.name}
                        onConfirm={() => revoke.mutate(apiKey.id)}
                      >
                        <Button variant="destructive" size="sm">
                          Revoke
                        </Button>
                      </RevokeApiKeyDialog>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
