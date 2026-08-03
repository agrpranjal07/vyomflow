import { createClerkClient } from "@clerk/backend";
import { prisma } from "@/lib/db";
import { unauthorized } from "@/lib/http";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export interface VerifiedIdentity {
  clerkUserId: string;
  email: string | null;
}

/**
 * Verifies the request's `Authorization: Bearer <token>` against Clerk and
 * returns the caller's identity, or null if unauthenticated/unverifiable.
 *
 * Cross-origin note: the frontend and backend are separate Next apps on
 * separate origins, so the Clerk session cookie never reaches this app —
 * only the Bearer token does. See S1-chat-surface.md's Auth correction.
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
// Convention: `Authorization: Bearer test:<clerkUserId>[:<email>]`.
const TEST_BEARER_PREFIX = "test:";

function verifyTestBearer(req: Request): VerifiedIdentity | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token.startsWith(TEST_BEARER_PREFIX)) return null;
  const [, clerkUserId, email] = token.split(":");
  if (!clerkUserId) return null;
  return { clerkUserId, email: email ?? null };
}

export const verifyWithClerk: Verifier = async (req) => {
  if (process.env.NODE_ENV === "test") {
    return verifyTestBearer(req);
  }

  const authedRequest = await clerkClient.authenticateRequest(req, {
    authorizedParties: [FRONTEND_ORIGIN],
  });
  const auth = authedRequest.toAuth();
  if (!auth || !auth.userId) return null;

  // Email is only needed once, at provisioning time, so this extra call is
  // not on the hot path of every authenticated request.
  let email: string | null = null;
  try {
    const user = await clerkClient.users.getUser(auth.userId);
    email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  } catch {
    // Non-fatal: provisioning still proceeds with a null email.
  }

  return { clerkUserId: auth.userId, email };
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
  const identity = await verify(req);
  if (!identity) return null;

  const user = await prisma.user.upsert({
    where: { clerkUserId: identity.clerkUserId },
    update: {},
    create: { clerkUserId: identity.clerkUserId, email: identity.email },
    select: { id: true },
  });

  return { userId: user.id };
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
  const result = await requireUser(req, verify);
  return result ?? unauthorized();
}
