"use client";

import { AttachmentTile } from "@/components/chat/attachment-tile";
import type { AttachmentItem } from "@/hooks/use-attachments";

/** Wrapping row of composer attachment tiles — only rendered when non-empty. */
export function AttachmentStrip({
  items,
  onRemove,
  onRetry,
}: {
  items: AttachmentItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <AttachmentTile key={item.attachmentId} item={item} onRemove={onRemove} onRetry={onRetry} />
      ))}
    </div>
  );
}
