"use client";

import { IconFile, IconMusic, IconVideo } from "@tabler/icons-react";
import type { AttachmentDTO } from "@/contracts/attachments";

/**
 * A sent message's attachment, once there are 2+: reference shows small
 * fixed-size square thumbnails side by side, not the full-width media
 * players GeneratedAsset renders for a single attachment (evidence:
 * reference multi-attachment sent bubble vs. the single-attachment case,
 * which does use GeneratedAsset — see message-bubble.tsx). Read-only —
 * no remove/retry chrome, unlike the composer's own AttachmentTile.
 */
export function SentAttachmentThumbnail({ attachment }: { attachment: AttachmentDTO }) {
  const isImage = attachment.mimeType?.startsWith("image/");
  const isVideo = attachment.mimeType?.startsWith("video/");

  return (
    <a
      href={attachment.resultUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={attachment.fileName ?? undefined}
      className="size-24 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-muted"
    >
      {isImage && attachment.resultUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- backend-hosted result URL, not a next/image remote-pattern candidate.
        <img src={attachment.resultUrl} alt={attachment.fileName ?? ""} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center">
          {isVideo ? (
            <IconVideo className="size-5 text-text-secondary" />
          ) : attachment.mimeType?.startsWith("audio/") ? (
            <IconMusic className="size-5 text-text-secondary" />
          ) : (
            <IconFile className="size-5 text-text-secondary" />
          )}
        </span>
      )}
    </a>
  );
}
