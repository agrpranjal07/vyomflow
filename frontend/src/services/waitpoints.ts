import type { Fetcher } from "@/lib/api-client";
import { WaitpointDTOSchema, type RespondToWaitpointRequest, type WaitpointDTO } from "@/contracts/waitpoints";

/** POST /api/v1/waitpoints/:waitpointId/respond — idempotent, ownership-checked (S6 §7.1/§7.8). */
export async function respondToWaitpoint(
  fetcher: Fetcher,
  waitpointId: string,
  body: RespondToWaitpointRequest,
): Promise<WaitpointDTO> {
  const raw = await fetcher(`/api/v1/waitpoints/${waitpointId}/respond`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return WaitpointDTOSchema.parse(raw);
}
