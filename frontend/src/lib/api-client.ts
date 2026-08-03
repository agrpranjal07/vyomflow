/**
 * The only file in this app allowed to call the platform `fetch`
 * (ESLint-enforced — no-restricted-globals in eslint.config.mjs). Service
 * modules under src/services/** never call fetch directly; they receive a
 * `Fetcher` (bound to the current Clerk token by useApiClient, see
 * src/hooks/use-api-client.ts) and always run the response through a Zod
 * schema before returning it.
 */
import { ApiErrorSchema } from "@/contracts/common";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<unknown>;

export function createFetcher(getToken: () => Promise<string | null>): Fetcher {
  return async (path, init = {}) => {
    const token = await getToken();
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const parsedError = ApiErrorSchema.safeParse(body);
      if (parsedError.success) {
        throw new ApiError(res.status, parsedError.data.error.code, parsedError.data.error.message);
      }
      throw new ApiError(res.status, "UNKNOWN", `Request failed with status ${res.status}`);
    }

    if (res.status === 204) return null;
    return res.json();
  };
}
