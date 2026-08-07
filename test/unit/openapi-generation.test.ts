/**
 * S8 fallback scope (S8-public-api-bonus.md) — OpenAPI generation
 * correctness. Backend-only tests (no DB), workspace-root `test/unit/` per
 * testing-policy.md. Imports the backend's own registry/generator (never a
 * duplicate copy) so drift in the real contracts fails this suite, not a
 * stale fixture.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "@/public-api/openapi/registry";
import { AgentRunStatusSchema } from "@/contracts/runs";

const BACKEND_ROOT = join(__dirname, "..", "..", "backend");
const generateDocument = generateOpenApiDocument;

/**
 * Walks `backend/src/app/api/v1/**` for `route.ts` files and converts each
 * to its Next.js App Router URL, e.g. `.../[chatId]/route.ts` ->
 * `/api/v1/chats/{chatId}`.
 */
function listActualRoutePaths(): Set<string> {
  const apiRoot = join(BACKEND_ROOT, "src", "app", "api");
  const paths = new Set<string>();

  function walk(dir: string, segments: string[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const segment = entry.startsWith("[") && entry.endsWith("]")
          ? `{${entry.slice(1, -1)}}`
          : entry;
        walk(full, [...segments, segment]);
      } else if (entry === "route.ts") {
        paths.add("/api/" + segments.join("/"));
      }
    }
  }

  walk(apiRoot, []);
  return paths;
}

describe("S8 OpenAPI generation", () => {
  it("produces a well-formed OpenAPI 3.1 document", () => {
    const doc = generateDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  it("documents exactly the routes that exist in the internal route tree — no invented paths, none missing", () => {
    const doc = generateDocument();
    const documented = new Set(Object.keys(doc.paths ?? {}));
    const actual = listActualRoutePaths();

    for (const path of documented) {
      expect(actual.has(path), `documented path ${path} has no matching route.ts`).toBe(true);
    }
    for (const path of actual) {
      expect(documented.has(path), `route.ts at ${path} is not documented`).toBe(true);
    }
  });

  it("AgentRun.status enum matches contracts/runs.ts exactly (S6/S7 drift guard)", () => {
    const doc = generateDocument();
    const schemas = doc.components?.schemas as Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    const documentedEnum = schemas?.AgentRun?.properties?.status?.enum;
    expect(documentedEnum).toEqual(AgentRunStatusSchema.options);
  });

  it("has no unresolved $ref against components/schemas", () => {
    const doc = generateDocument();
    const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = new Set<string>();

    function walk(node: unknown) {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") refs.add(value);
          else walk(value);
        }
      }
    }
    walk(doc);

    for (const ref of refs) {
      if (!ref.startsWith("#/components/schemas/")) continue;
      const name = ref.replace("#/components/schemas/", "");
      expect(schemaNames.has(name), `unresolved $ref: ${ref}`).toBe(true);
    }
  });
});
