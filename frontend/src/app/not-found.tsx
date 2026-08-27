"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

// Root-level not-found: per Next's file-convention docs, this file catches
// every unmatched URL for the whole app, not just an explicit notFound()
// throw. `replace` (not a server `redirect()`) so the bad URL never lands
// in browser history.
export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-background text-center">
      <Skeleton className="h-6 w-40" />
      <p className="text-sm text-text-secondary">Redirecting…</p>
    </div>
  );
}
