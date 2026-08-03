import type { AnchorHTMLAttributes } from "react";

// Stand-in for next/link in the test workspace. next/link's real implementation reaches for the
// App Router context via useContext — a hook call that requires its own React module instance to
// be the SAME instance react-dom renders with. "next" isn't installed in this test workspace, so
// vi.mock("next/link", ...) declared from a test file can never resolve/intercept the real module
// (it lives only in frontend/node_modules, resolved relative to the importing frontend/src file) —
// the real Link always loads, duplicating React and crashing with "Invalid hook call" on render.
// Aliased at the Vite config level (vitest.frontend.config.mts) instead, same fix pattern already
// used there for react/react-dom/lucide-react/@tanstack/react-query: a single physical module every
// import of "next/link" resolves to, regardless of which file requests it.
export default function Link({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
