---
name: merge-videos-guidance
description: Load before calling merge_videos to get video ordering right, pick a transition, and respect the 2-100 URL count bound.
---

# Merge Videos Guidance

The `video_urls` array order is preserved directly into the merged output — the first URL becomes
the first clip in the result, and so on. Confirm the intended sequence with the user (or infer it
from context, e.g. "intro then demo then outro") before calling the tool; reordering after merging
requires a new merge, not an edit.

Choose the transition option based on the desired feel between clips: use `none` for a hard cut
when clips should snap directly into one another (interviews, screen recordings, distinct scenes),
`fade` for a simple fade-to-black-and-back between clips (good general-purpose default for a
softer break), and `dissolve` for a cross-fade where the outgoing and incoming clips blend directly
into each other (best for continuous or visually related footage).

`video_urls` must contain between 2 and 100 URLs — a single video isn't a merge, and there's a hard
upper bound of 100. Validate the count and ordering before calling; don't call with 1 URL or an
unconfirmed order.
