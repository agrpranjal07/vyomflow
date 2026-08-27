import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useRouter } from "next/navigation";
import NotFound from "@/app/not-found";

// Root app/not-found.tsx catches every unmatched URL app-wide (Next's
// file-convention docs) — verified here at the unit level since this repo
// has no Playwright/E2E infra to drive an actual bad URL through the router.

describe("app/not-found.tsx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces the current entry with the homepage on mount", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    });

    render(<NotFound />);

    expect(replace).toHaveBeenCalledWith("/");
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
