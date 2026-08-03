/** Builds an authenticated Request against the test-only Bearer convention (see src/lib/auth.ts). */
export function authedRequest(
  url: string,
  clerkUserId: string,
  init: RequestInit & { email?: string } = {},
): Request {
  const { email, ...rest } = init;
  const token = email ? `test:${clerkUserId}:${email}` : `test:${clerkUserId}`;
  return new Request(url, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export function anonymousRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}
