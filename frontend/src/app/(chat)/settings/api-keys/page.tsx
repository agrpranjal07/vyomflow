"use client";

import { APIKeys } from "@clerk/nextjs";

/**
 * Standalone /settings/api-keys page — lets a signed-in user mint/manage
 * their own Clerk API keys for the public REST/MCP surface (session-token
 * protected like every other page under (chat)/, per proxy.ts). Reached from
 * the sidebar's "API Keys" nav row. Renders Clerk's own <APIKeys /> widget
 * rather than a hand-rolled key-management UI; header follows this app's
 * existing settings/dashboard-page title pattern (usage/page.tsx).
 */
export default function ApiKeysPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-[1472px]">
        <h1 className="text-[30px] font-bold leading-9 text-text-primary">API Keys</h1>
        <p className="mt-1.5 text-lg leading-7 text-text-secondary">
          Create and manage API keys for the VyomFlow public API and MCP server
        </p>

        <div className="mt-6">
          <APIKeys />
        </div>
      </div>
    </div>
  );
}
