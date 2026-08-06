---
name: generate-image-guidance
description: Load before calling generate_image to write an effective prompt and understand its real capabilities (single unified generate/edit call, up to 4 reference images, no mask/inpainting, seed/guidance params).
---

# Generate Image Guidance

`generate_image` is a single, unified tool — there is no separate text/edit sub-model to choose.
Providing `images` (up to 4 reference image URLs) automatically puts the call in edit/reference
mode; omitting `images` generates purely from the text prompt. Never ask the user to pick a mode.

Real capabilities and limits (Cloudflare Workers AI `flux-2-klein-4b`, not the old provider):

- **Up to 4 reference images**, not 10 — if the user supplies more, use only the most relevant
  four and say so.
- **No mask/inpainting.** There is no way to constrain an edit to a specific region of a reference
  image — describe the desired change in the prompt instead of asking for a masked area.
- **`seed`** (optional integer) — set it when the user wants a reproducible or a deliberately
  varied result across repeated calls; omit it to let generation be randomized.
- **`guidance`** (optional positive number) — higher values push the output to follow the prompt
  more literally at some cost to creative variation; there is no confirmed numeric range for this
  model, so treat it as a coarse dial rather than a precise setting.
- **`n`** (1-4) generates that many images from independent calls — useful when the user wants
  options to choose from, but each additional image costs real generation credit, so don't default
  to a high `n` without reason.
- **`size`** is bounded to 256-1920px per side — do not request sizes outside that range.

A good prompt states the subject first, then style/mood, then composition/framing, and finally any
constraints on what to avoid. Be concrete about medium (photo, illustration, 3D render), lighting,
and color palette when they matter to the user's intent — vague prompts produce inconsistent
results. In reference-image mode, describe only the change being made, not the entire scene, so
the model preserves everything else from the reference.

Before calling the tool, run through `assets/prompt-checklist.md` to catch missing detail that
tends to produce weak or off-target generations.
