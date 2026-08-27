"use client";

import { useAPIKeys, useClerk } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog";

/**
 * Standalone /settings/api-keys page — lets a signed-in user mint/manage
 * their own Clerk API keys for the public REST/MCP surface (session-token
 * protected like every other page under (chat)/, per proxy.ts).
 *
 * Create goes through our own backend (`CreateApiKeyDialog` -> POST
 * /api/v1/api-keys), never Clerk's `<APIKeys/>` widget / Frontend API:
 * confirmed live that Frontend-API-minted keys carry zero scopes and 403
 * on every public route, since scopes can only be set via the Backend API
 * (Context7 `/clerk/clerk-docs`). Listing and revocation stay on Clerk's
 * own `useAPIKeys()`/`clerk.apiKeys.revoke` — those operations are
 * scope-agnostic and a Backend-API-created key is still a normal
 * `api_keys` resource under the same user, so it appears here like any
 * other key.
 */
export default function ApiKeysPage() {
  const { data: apiKeys, isLoading, revalidate } = useAPIKeys();
  const clerk = useClerk();

  async function handleRevoke(apiKeyId: string) {
    if (!confirm("Revoke this API key? This can't be undone.")) return;
    await clerk.apiKeys.revoke({
      apiKeyID: apiKeyId,
      revocationReason: "Revoked by user",
    });
    revalidate();
  }

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
          <CreateApiKeyDialog onCreated={revalidate} />
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
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevoke(apiKey.id)}
                      >
                        Revoke
                      </Button>
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
