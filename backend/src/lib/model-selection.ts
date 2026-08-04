/**
 * Model-selection resolution for the send route (S2-streaming-turn.md).
 * The four-outcome *rejection* logic (malformed / unsupported) already
 * lives in CreateMessageRequestSchema (pure Zod, contracts/messages.ts) —
 * by the time a request reaches this module it has already passed that
 * schema, so `model` is either `undefined` (absent) or exactly
 * OPENROUTER_FREE_MODEL (the only value the schema lets through). This
 * module's only job is the "absent -> default" half of the requirement.
 */
import { OPENROUTER_FREE_MODEL } from "@/contracts/messages";

export function resolveRequestedModel(model: string | undefined): string {
  return model ?? OPENROUTER_FREE_MODEL;
}

export { OPENROUTER_FREE_MODEL };
