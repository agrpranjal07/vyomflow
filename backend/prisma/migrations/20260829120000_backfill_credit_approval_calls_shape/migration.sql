-- Backfill legacy CREDIT_APPROVAL waitpoint rows from the pre-2026-08-29
-- single-call payload shape {toolName, estimatedCredits, threshold} to the
-- current round shape {calls: [...], estimatedCredits, threshold}.
--
-- The backend contract (src/contracts/waitpoints.ts) already tolerates both
-- shapes via a z.preprocess upgrade at read time — this migration converges
-- the stored data itself so the normalizer is defence-in-depth against
-- future worker/API version skew, not a permanent crutch for this one
-- historical shape change.
UPDATE "waitpoints"
SET "requestPayload" = jsonb_build_object(
  'calls', jsonb_build_array(
    jsonb_build_object(
      'toolCallId', '',
      'toolName', "requestPayload"->>'toolName',
      'estimatedCredits', ("requestPayload"->>'estimatedCredits')::numeric
    )
  ),
  'estimatedCredits', ("requestPayload"->>'estimatedCredits')::numeric,
  'threshold', ("requestPayload"->>'threshold')::numeric
)
WHERE "kind" = 'CREDIT_APPROVAL'
  AND "requestPayload" ? 'toolName'
  AND NOT ("requestPayload" ? 'calls');
