import { createClerkClient } from "@clerk/backend";
import { prisma } from "@/lib/db";
import { unauthorized, forbidden } from "@/lib/http";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export interface VerifiedIdentity {
  clerkUserId: string;
  email: string | null;
  tokenType: "session_token" | "api_key";
  scopes: string[];
  /**
   * The API key's own id (Clerk's `AuthenticatedMachineObject.id`, distinct
   * from `auth.subject`/`clerkUserId` — confirmed against the installed
   * `@clerk/backend` `APIKey` resource type). `null` for session_token.
   * Rate-limiting buckets on this, not `clerkUserId`, so two keys belonging
   * to the same user throttle independently (S8 Phase 3).
   */
  apiKeyId: string | null;
}

/**
 * Verifies the request's `Authorization: Bearer <token>` against Clerk and
 * returns the caller's identity, or null if unauthenticated/unverifiable.
 *
 * Same-site note: `www.vyomflow.co.in` and `api.vyomflow.co.in` are both
 * `.vyomflow.co.in`, so a Clerk session cookie set by the frontend *can*
 * reach this app now (unlike the old cross-origin Vercel-subdomain setup).
 * Auth here stays bearer-only regardless — no route ever reads a cookie —
 * which is exactly what makes `publicCorsHeaders()`'s `Access-Control-
 * Allow-Origin: *` (lib/http.ts) safe: no ambient credential can ever
 * authorize a request, so an arbitrary origin reading the response is not
 * a CSRF/session-riding risk.
 *
 * This is a swappable function (not a hard call site) precisely so
 * integration tests can inject a deterministic stub instead of hitting
 * Clerk's network for every test run — see test/support/auth.ts.
 */
export type Verifier = (req: Request) => Promise<VerifiedIdentity | null>;

// Test-only deterministic bypass so integration tests exercise the real
// route handlers (imported and invoked directly, real Prisma/Postgres)
// without spending the shared, rate-limited Clerk network budget or
// depending on network access at all. Guarded by NODE_ENV === "test", which
// Vitest sets automatically and which is never the runtime value in dev or
// production — this code path is unreachable outside the test runner.
// Convention: `Authorization: Bearer test:<clerkUserId>[:<email>[:<scope,scope>[@<apiKeyId>]]]`.
// A 4th segment (comma-separated scopes) simulates an api_key identity;
// its absence keeps the original two/three-segment forms as session_token.
// An optional `@<apiKeyId>` suffix on the scope segment simulates a distinct
// API key belonging to the same clerkUserId (rate-limit-isolation tests);
// omitting it defaults to one deterministic per-user key id, so every
// existing single-key test is unaffected.
const TEST_BEARER_PREFIX = "test:";

function verifyTestBearer(req: Request): VerifiedIdentity | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token.startsWith(TEST_BEARER_PREFIX)) return null;
  // Real scope literals contain a colon themselves (e.g. "chats:write"), so
  // a plain 4-way `token.split(":")` destructure truncates the scope
  // segment at its own first colon. Split only the first two separators
  // (userId, email) and rejoin everything after them verbatim as the scope
  // segment — the 2/3-segment (no scopes) forms are unaffected since
  // `parts.slice(3)` is then empty and `scopeList` stays undefined.
  const parts = token.split(":");
  const clerkUserId = parts[1];
  const email = parts[2];
  const scopeSegment = parts.length > 3 ? parts.slice(3).join(":") : undefined;
  if (!clerkUserId) return null;
  if (scopeSegment !== undefined) {
    const [scopeList, explicitKeyId] = scopeSegment.split("@");
    return {
      clerkUserId,
      email: email ?? null,
      tokenType: "api_key",
      scopes: scopeList.split(",").filter(Boolean),
      apiKeyId: explicitKeyId || `test-key:${clerkUserId}`,
    };
  }
  return { clerkUserId, email: email ?? null, tokenType: "session_token", scopes: [], apiKeyId: null };
}

export const verifyWithClerk: Verifier = async (req) => {
  if (process.env.NODE_ENV === "test") {
    return verifyTestBearer(req);
  }

  // authorizedParties verifies the JWT `azp` claim, which only session
  // tokens carry (Clerk skips this check when `azp` is absent) — so this
  // applies to session_token requests only and never rejects api_key
  // traffic, which has no Origin/azp to begin with (confirmed via Context7
  // /clerk/clerk-docs: production.mdx + manual-jwt-verification.mdx).
  const authedRequest = await clerkClient.authenticateRequest(req, {
    authorizedParties: [FRONTEND_ORIGIN],
    acceptsToken: ["session_token", "api_key"] as const,
  });
  const auth = authedRequest.toAuth();
  if (!auth) return null;

  if (auth.tokenType === "api_key") {
    if (!auth.subject) return null;
    return {
      clerkUserId: auth.subject,
      email: null,
      tokenType: "api_key",
      scopes: auth.scopes ?? [],
      apiKeyId: auth.id,
    };
  }

  // InvalidTokenAuthObject (tokenType null) and a signed-out session both
  // fall through here; narrow to SignedInAuthObject explicitly rather than
  // relying on `!auth.userId` alone, which InvalidTokenAuthObject has no
  // property for at all.
  if (auth.tokenType !== "session_token" || !auth.userId) return null;

  // Email is only needed once, at provisioning time, so this extra call is
  // not on the hot path of every authenticated request. Skipped entirely
  // for api_key requests above — that caller is by definition already
  // provisioned, so the round trip would be pure waste.
  let email: string | null = null;
  try {
    const user = await clerkClient.users.getUser(auth.userId);
    email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  } catch {
    // Non-fatal: provisioning still proceeds with a null email.
  }

  return { clerkUserId: auth.userId, email, tokenType: "session_token", scopes: [], apiKeyId: null };
};

/**
 * Verifies the request and provisions a `User` row on first sight.
 * Provisioning uses an upsert keyed on the unique `clerkUserId` column, so
 * concurrent first-sight requests for the same Clerk user serialize through
 * Postgres's own unique-constraint conflict resolution rather than a
 * read-then-write race in application code.
 */
export async function requireUser(
  req: Request,
  verify: Verifier = verifyWithClerk,
): Promise<{ userId: string } | null> {
  const result = await requireUserWithIdentity(req, verify);
  return result ? { userId: result.userId } : null;
}

async function requireUserWithIdentity(
  req: Request,
  verify: Verifier = verifyWithClerk,
): Promise<{ userId: string; identity: VerifiedIdentity } | null> {
  const identity = await verify(req);
  if (!identity) return null;

  const user = await prisma.user.upsert({
    where: { clerkUserId: identity.clerkUserId },
    update: {},
    create: { clerkUserId: identity.clerkUserId, email: identity.email },
    select: { id: true },
  });

  return { userId: user.id, identity };
}

/**
 * Route Handler convenience: returns `{ userId }` or a ready-to-return 401
 * Response, so every handler's auth check is one line:
 * `const auth = await authenticate(req); if (auth instanceof Response) return auth;`
 */
export async function authenticate(
  req: Request,
  verify: Verifier = verifyWithClerk,
): Promise<{ userId: string } | Response> {
  const result = await authenticateWithIdentity(req, verify);
  return result instanceof Response ? result : { userId: result.userId };
}

/**
 * Same as `authenticate`, but also surfaces `VerifiedIdentity` (tokenType,
 * scopes) for routes that need `requireScopes` — the public/MCP surface.
 * `authenticate` calls into this so there is exactly one auth code path.
 * `corsProfile` must be `"public"` for `/api/public/v1/*` and `/api/mcp`
 * callers — otherwise the 401 Response carries the private (FRONTEND_ORIGIN-
 * only) CORS headers instead of `*`, breaking CORS on the auth failure path.
 */
export async function authenticateWithIdentity(
  req: Request,
  verify: Verifier = verifyWithClerk,
  corsProfile: "private" | "public" = "private",
): Promise<{ userId: string; identity: VerifiedIdentity } | Response> {
  const result = await requireUserWithIdentity(req, verify);
  return result ?? unauthorized(corsProfile);
}

/**
 * Scope gate for the public/MCP surface only — always uses the public CORS
 * profile, since a session-token caller (the only other tokenType) never
 * reaches this function with a missing scope (see the early return below).
 */
export function requireScopes(
  auth: { tokenType: string; scopes: string[] },
  ...required: string[]
): Response | null {
  if (auth.tokenType === "session_token") return null;
  const missing = required.filter((s) => !auth.scopes.includes(s));
  if (missing.length === 0) return null;
  return forbidden(`Missing required scope(s): ${missing.join(", ")}.`, "public");
}
