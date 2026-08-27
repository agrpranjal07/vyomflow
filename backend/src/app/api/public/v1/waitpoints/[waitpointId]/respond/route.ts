import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { badRequest, notFound, publicHandleOptions, publicJson } from "@/lib/http";
import { WaitpointIdParamSchema, WaitpointDTOSchema, RespondToWaitpointRequestSchema } from "@/contracts/waitpoints";
import { respondToWaitpoint, WaitpointNotFoundError, WaitpointKindMismatchError } from "@/services/waitpoints";

export function OPTIONS() {
  return publicHandleOptions();
}

/** Public mirror of POST /api/v1/waitpoints/{waitpointId}/respond — same idempotent resume semantics (C17: a repeat call on an already-resolved waitpoint still returns 200). */
export async function POST(req: Request, { params }: { params: Promise<{ waitpointId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "waitpoints:respond");
  if (scopeErr) return scopeErr;

  const parsedParams = WaitpointIdParamSchema.safeParse(await params);
  if (!parsedParams.success) return notFound("public");

  const parsedBody = RespondToWaitpointRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) return badRequest("Invalid request.", parsedBody.error.flatten(), "public");

  try {
    const result = await respondToWaitpoint(parsedParams.data.waitpointId, auth.userId, parsedBody.data);
    return publicJson(WaitpointDTOSchema.parse(result.waitpoint));
  } catch (error) {
    if (error instanceof WaitpointNotFoundError) return notFound("public");
    if (error instanceof WaitpointKindMismatchError) return badRequest(error.message, undefined, "public");
    throw error;
  }
}
