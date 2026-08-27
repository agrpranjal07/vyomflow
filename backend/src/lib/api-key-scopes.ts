/**
 * Default scope grant for self-serve API keys minted via
 * `POST /api/v1/api-keys` (see that route). Exactly the six scopes actually
 * enforced by `requireScopes(...)` across `src/app/api/public/v1/**` —
 * confirmed by grep, not assumed. Keep in sync if a new public route adds a
 * scope gate.
 */
export const PUBLIC_API_DEFAULT_SCOPES = [
  "chats:read",
  "chats:write",
  "runs:read",
  "runs:write",
  "waitpoints:respond",
  "credits:read",
] as const;
