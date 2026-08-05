/**
 * Shared MSW server + handler factories for mocking the Transloadit API.
 * Mirrors msw-cloudflare.ts's shape — no live Transloadit calls in any
 * automated suite.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const TRANSLOADIT_API_BASE_URL = "https://api2.transloadit.com";
export const TRANSLOADIT_STATUS_BASE_URL = "https://api2-euwest.transloadit.com";

/**
 * `response` should carry `assembly_id` + `assembly_ssl_url` — the real
 * POST /assemblies response is the full Assembly status object, not a slim
 * {assembly_id, url} envelope (confirmed against a real Transloadit call
 * during live verification 2026-08-21; client.ts reads `assembly_ssl_url`,
 * falling back to `assembly_url`).
 */
export function transloaditCreateAssemblyHandler(
  response: { assembly_id: string; assembly_ssl_url: string } | unknown,
  status = 200,
) {
  return http.post(`${TRANSLOADIT_API_BASE_URL}/assemblies`, () => HttpResponse.json(response, { status }));
}

export function transloaditCreateAssemblyErrorHandler(status: number, body: unknown) {
  return http.post(`${TRANSLOADIT_API_BASE_URL}/assemblies`, () => HttpResponse.json(body, { status }));
}

export function transloaditStatusHandler(statusUrl: string, body: unknown, status = 200) {
  return http.get(statusUrl, () => HttpResponse.json(body, { status }));
}

export const transloaditServer = setupServer();
