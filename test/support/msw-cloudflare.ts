/**
 * Shared MSW server + handler factories for mocking Cloudflare Workers AI's
 * flux-2-klein-4b endpoint. Mirrors msw-transloadit.ts's pattern: a
 * setupServer() export plus handler-factory functions. No live Cloudflare
 * calls in any automated suite.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const CLOUDFLARE_ACCOUNT_ID = "test_account_id";
const MODEL_PATH = `/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`;
export const CLOUDFLARE_RUN_URL = `https://api.cloudflare.com${MODEL_PATH}`;

/** Successful generation — the confirmed-live envelope shape (recon-findings.md §7). */
export function cloudflareSuccessHandler(base64Image: string) {
  return http.post(CLOUDFLARE_RUN_URL, () =>
    HttpResponse.json({ result: { image: base64Image }, success: true, errors: [], messages: [] }),
  );
}

/** Provider-reported failure (success:false) — a 200 HTTP status with an error envelope. */
export function cloudflareFailureHandler(errors: unknown[] = [{ message: "generation failed" }]) {
  return http.post(CLOUDFLARE_RUN_URL, () =>
    HttpResponse.json({ result: null, success: false, errors, messages: [] }),
  );
}

/** Non-2xx HTTP response (4xx/5xx). */
export function cloudflareHttpErrorHandler(status: number, body: unknown = { success: false, errors: [{ message: "error" }] }) {
  return http.post(CLOUDFLARE_RUN_URL, () => HttpResponse.json(body, { status }));
}

/** Delayed response, for exercising a timeout/abort against a short-timeout signal. */
export function cloudflareDelayedHandler(base64Image: string, delayMs: number) {
  return http.post(CLOUDFLARE_RUN_URL, async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return HttpResponse.json({ result: { image: base64Image }, success: true, errors: [], messages: [] });
  });
}

/** Captures the last request's parsed FormData for assertions (e.g. input_image_N presence). */
export function cloudflareCapturingHandler(base64Image: string, onRequest: (form: FormData) => void) {
  return http.post(CLOUDFLARE_RUN_URL, async ({ request }) => {
    const form = await request.formData();
    onRequest(form);
    return HttpResponse.json({ result: { image: base64Image }, success: true, errors: [], messages: [] });
  });
}

export const cloudflareServer = setupServer();
