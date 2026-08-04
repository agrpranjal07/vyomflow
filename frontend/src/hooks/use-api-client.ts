"use client";

import { useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { createFetcher, type Fetcher } from "@/lib/api-client";

/** The bound fetcher every service call goes through, scoped to the signed-in user's current Clerk token. */
export function useApiClient(): Fetcher {
  const { getToken } = useAuth();
  return useMemo(() => createFetcher(getToken), [getToken]);
}
