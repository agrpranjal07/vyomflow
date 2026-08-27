/**
 * Builds an authenticated Request against the test-only Bearer convention
 * (see src/lib/auth.ts). Passing `scopes` simulates an api_key identity
 * (`test:<clerkUserId>:<email>:<scope,scope>[@<apiKeyId>]`) — used by the
 * public API surface's scope-gated tests; omitting it keeps the original
 * session_token two/three-segment form unchanged. Passing `apiKeyId` (only
 * meaningful alongside `scopes`) simulates a second, distinct API key
 * belonging to the same clerkUserId — used by per-key rate-limit-isolation
 * tests; omitting it defaults to one deterministic key id per user.
 */
export function authedRequest(
  url: string,
  clerkUserId: string,
  init: RequestInit & { email?: string; scopes?: string[]; apiKeyId?: string } = {},
): Request {
  const { email, scopes, apiKeyId, ...rest } = init;
  const token = scopes
    ? `test:${clerkUserId}:${email ?? ""}:${scopes.join(",")}${apiKeyId ? `@${apiKeyId}` : ""}`
    : email
      ? `test:${clerkUserId}:${email}`
      : `test:${clerkUserId}`;
  return new Request(url, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export function anonymousRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}
