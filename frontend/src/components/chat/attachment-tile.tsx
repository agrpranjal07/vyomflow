"use client";

import { useEffect, useMemo, useState } from "react";
import { IconMusic, IconVideo, IconFile, IconX, IconRotate, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { AttachmentItem } from "@/hooks/use-attachments";

/**
 * One ~62px composer attachment tile: square thumbnail, small radius, a
 * dismiss badge half-overlapping the top-right corner. While uploading, the
 * reference product replaces the thumbnail entirely with a centered
 * spinning loader on the tile's flat muted background — confirmed against a
 * live reference screenshot (not the earlier composer--attachment-uploading
 * evidence file, which turned out to be indistinguishable from --ready and
 * misled the original build toward a bottom progress-bar affordance instead).
 */
export function AttachmentTile({
  item,
  onRemove,
  onRetry,
}: {
  item: AttachmentItem;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  // Object URLs are created/revoked in a single effect (not useMemo +
  // separate cleanup) — React 18 Strict Mode double-invokes effects in dev,
  // and a create-in-useMemo/revoke-in-useEffect split lets the cleanup
  // revoke the one and only blob URL from the memo, leaving the remount
  // with an already-revoked URL and a permanently broken image.
  // item.file/mimeType are fixed for the lifetime of an attachment item, so
  // this never needs to clear a stale URL — only create-once-then-revoke.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.file || !item.mimeType.startsWith("image/")) return;
    const url = URL.createObjectURL(item.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must create/revoke the blob URL within the same effect invocation (see comment above), which requires setting state from it.
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, item.mimeType]);

  // No thumbnail while uploading — the reference shows a bare spinner on
  // the tile's flat background, not a preview-with-overlay.
  const previewUrl =
    item.status === "uploading" ? null : (objectUrl ?? (item.mimeType.startsWith("image/") ? item.resultUrl : null));
  const isVideo = item.mimeType.startsWith("video/");
  const isAudio = item.mimeType.startsWith("audio/");

  const icon = useMemo(() => {
    if (isVideo) return <IconVideo className="size-5 text-text-secondary" />;
    if (isAudio) return <IconMusic className="size-5 text-text-secondary" />;
    return <IconFile className="size-5 text-text-secondary" />;
  }, [isVideo, isAudio]);

  return (
    <div className="group/tile relative size-[62px] shrink-0">
      <div
        className={cn(
          "size-full overflow-hidden rounded-[var(--radius-sm)] bg-muted",
          item.status === "failed" && "ring-1 ring-destructive/50",
        )}
        title={item.fileName}
      >
        {item.status === "uploading" ? (
          <div className="flex size-full items-center justify-center">
            <IconLoader2 className="size-5 animate-spin text-text-secondary" />
          </div>
        ) : previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local blob/backend-hosted preview, not a next/image remote-pattern candidate.
          <img src={previewUrl} alt={item.fileName} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">{icon}</div>
        )}
      </div>

      {item.status === "failed" && (
        <button
          type="button"
          onClick={() => onRetry(item.attachmentId)}
          aria-label={`Retry uploading ${item.fileName}`}
          className="absolute inset-0 flex items-center justify-center rounded-[var(--radius-sm)] bg-destructive/10"
        >
          <IconRotate className="size-4 text-destructive" />
        </button>
      )}

      <button
        type="button"
        onClick={() => onRemove(item.attachmentId)}
        aria-label={`Remove ${item.fileName}`}
        className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-foreground text-background"
      >
        <IconX className="size-2.5" />
      </button>
    </div>
  );
}
