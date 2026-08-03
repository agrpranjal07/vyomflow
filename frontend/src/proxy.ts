// Next.js 16 renamed `middleware.ts` to `proxy.ts` (same behavior, new file
// name — see .claude/state/recon-findings.md). This only protects pages;
// the backend does its own independent Bearer-token verification for
// /api/v1/* — see S1-chat-surface.md's Auth correction.
//
// The chat shell ("/" and "/c/:chatId") is guest-browsable, matching the
// reference product: signed-out visitors can see the empty sidebar/composer
// and only get prompted to sign in when they attempt an auth-required
// action (send message, etc. — enforced by the backend's Bearer check, not
// here). Auth pages stay public too. Any future genuinely-sensitive page
// (e.g. a settings route) should be added to the protected default by
// simply NOT listing it here.
//
// Do NOT enable `frontendApiProxy` here: Clerk's Frontend API proxy/custom-
// domain feature is Production-instance only (confirmed in Clerk Dashboard
// > Domains — no proxy configuration option exists for a Development
// instance, only "You'll need to configure a custom domain in production").
// This app runs on Development instance keys in production per the
// project's own architecture decision, so enabling it makes every
// `/__clerk/*` handshake fail with `proxy_request_invalid_secret_key`,
// regardless of whether the secret key is correct. Clerk JS loads directly
// from the instance's own Frontend API domain (`*.clerk.accounts.dev`)
// instead, which is the supported path for Development keys.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/c/(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
