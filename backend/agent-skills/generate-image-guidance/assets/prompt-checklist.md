# Prompt Checklist

Before calling `generate_image`, verify the prompt covers:

- **Subject clarity** — the main subject is named specifically (not "a person" but "a woman in a
  red raincoat"); count and identity of subjects is unambiguous.
- **Style/mood** — medium is stated (photo, illustration, watercolor, 3D render, etc.) and the
  intended mood/tone (bright and playful, moody and cinematic, minimal and clean).
- **Composition** — framing (close-up, wide shot, portrait/landscape orientation), camera angle,
  and where the subject sits in the frame.
- **Lighting and color** — light source/quality (soft daylight, harsh studio light, golden hour)
  and any specific color palette the user wants honored.
- **Background/setting** — what surrounds the subject, or explicitly "plain background" if the
  user wants the subject isolated.
- **Negative constraints** — anything the user wants excluded (no text overlays, no watermark, no
  extra limbs/objects) stated explicitly rather than assumed.
- **Reference-image scope** (when `images` are provided) — the prompt describes only the delta
  being applied to the reference image(s), not a full re-description of the whole scene; remember
  there is no mask/inpainting, so a region-specific edit must be described in words.
- **Output intent** — any aspect ratio, resolution, or intended use (thumbnail, hero image, icon)
  that should shape composition choices.

If more than one or two of these are missing from the user's request, ask a clarifying question or
make a reasonable, stated assumption before calling the tool.
