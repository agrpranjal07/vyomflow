import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json, notFound } from "@/lib/http";
import { WaitpointIdParamSchema, WaitpointDTOSchema, RespondToWaitpointRequestSchema } from "@/contracts/waitpoints";
import { respondToWaitpoint, WaitpointNotFoundError, WaitpointKindMismatchError } from "@/services/waitpoints";

export function OPTIONS() {
  return handleOptions();
}

/**
 * POST /api/v1/waitpoints/:waitpointId/respond (.claude/specs/
 * S6-reliability-implementation-plan.md §6.3/§7.1) — the one resume
 * endpoint shared by both waitpoint kinds. Idempotent: a repeat call on an
 * already-resolved waitpoint still returns 200 with the current DTO (C17),
 * never an error.
 */
export async function POST(req: Request, { params }: { params: Promise<{ waitpointId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsedParams = WaitpointIdParamSchema.safeParse(await params);
  if (!parsedParams.success) return notFound();

  const parsedBody = RespondToWaitpointRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) return badRequest("Invalid request.", parsedBody.error.flatten());

  try {
    const result = await respondToWaitpoint(parsedParams.data.waitpointId, auth.userId, parsedBody.data);
    return json(WaitpointDTOSchema.parse(result.waitpoint));
  } catch (error) {
    if (error instanceof WaitpointNotFoundError) return notFound();
    if (error instanceof WaitpointKindMismatchError) return badRequest(error.message);
    throw error;
  }
}
