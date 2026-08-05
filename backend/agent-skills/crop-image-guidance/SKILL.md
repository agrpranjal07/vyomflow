---
name: crop-image-guidance
description: Load before calling crop_image to choose the right coordinate format (percent, exact pixels, or a crop object) and avoid partial/out-of-bounds rectangles.
---

# Crop Image Guidance

`crop_image` accepts a crop region as flat fields — there is no nested `crop` object. Provide
`image_url` plus exactly one of:

- **Percent rectangle**: `x_percent`, `y_percent`, `width_percent`, `height_percent` — all four
  required together, each in `[0, 100]`, with `x_percent + width_percent <= 100` and
  `y_percent + height_percent <= 100`. Use this when the user describes the crop in relative terms
  ("top half", "center square") or when exact source dimensions are unknown.
- **Pixel rectangle**: `width_px` and `height_px` are required together (positive integers);
  `x_px`/`y_px` are optional and default to positioning from the origin if omitted. Use this when
  the user supplies precise numbers, or when a prior tool call already returned the image's actual
  width/height and the target region should be pixel-exact.

## Common mistakes

- Supplying only part of a rectangle (e.g. `x_percent`/`y_percent` with no `width_percent`/
  `height_percent`, or `width_px` without `height_px`) — always submit a complete rectangle for
  whichever mode you use.
- Mixing percent and pixel fields in the same call — pick one coordinate system per call, never
  both.
- Omitting both a percent and a pixel rectangle entirely — one complete rectangle is required.
- Coordinates or `width`/`height` that exceed the source image's actual dimensions, or negative
  `x_px`/`y_px` — the server clamps the resolved rectangle to the source image's bounds rather than
  rejecting it outright, which can silently shrink the crop from what was requested. If the
  clamp shrinks the rectangle to zero width or height (e.g. `x_px` at or beyond the image's right
  edge), the crop still fails with a hard error rather than succeeding with an empty result.
  Confirm the source image size before computing exact pixel values whenever it's available.
