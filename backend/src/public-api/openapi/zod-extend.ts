/**
 * Must be imported FIRST — before any `src/contracts/**` module — anywhere
 * this package's OpenAPI generation runs. `extendZodWithOpenApi` patches
 * `ZodType.prototype`, but zod4 schemas are built via a per-instance mixin,
 * not late-bound prototype lookup: a schema constructed before this patch
 * runs never gains `.openapi()`, even though it reports the same
 * `Object.getPrototypeOf()`. Static ESM imports evaluate depth-first in
 * source order, so importing this file's side effect ahead of the registry
 * (which imports the contracts) is sufficient — no dynamic import needed.
 */
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);
