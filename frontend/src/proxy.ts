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
// `frontendApiProxy` is left disabled/unchanged here. This app now runs a
// genuine Clerk Production instance on custom domains
// (https://www.vyomflow.co.in etc.), so the earlier rationale for not
// enabling it — Development-instance keys lacking proxy support — no
// longer applies. Whether to turn `frontendApiProxy` on is a functional
// decision, not a documentation fix, and hasn't been made; do not enable
// it without deliberately verifying the proxy path against the production
// instance first.
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
