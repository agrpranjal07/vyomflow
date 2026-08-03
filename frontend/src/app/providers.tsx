"use client";

import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

// Chat-list/detail query keys aren't scoped by user identity — without this,
// a sign-out (or switching accounts) in the same tab could briefly show the
// previous user's cached chats before fresh data loads (audit finding #10).
// Clearing the whole cache on any identity change (including to signed-out)
// is simpler and just as effective as threading userId through every key.
function QueryCacheAuthScope() {
  const { userId, isLoaded } = useAuth();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      queryClient.clear();
    }
    previousUserId.current = userId;
  }, [isLoaded, userId, queryClient]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1 },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <QueryCacheAuthScope />
        {children}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
