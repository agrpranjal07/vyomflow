"use client";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MediaLibraryView } from "@/components/chat/media-library-view";
import type { AttachmentDTO } from "@/contracts/attachments";

/** The attach-menu's "Select Asset" popup — wraps the shared MediaLibraryView in a Dialog. */
export function MediaLibraryDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted when opened as a standalone library (e.g. from the sidebar) rather than a composer picker — a card click then only toggles selection. */
  onSelect?: (attachment: AttachmentDTO) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[88vh] w-[1060px] max-w-[96vw] flex-col gap-0 rounded-2xl bg-white p-0 shadow-2xl ring-0 sm:max-w-[96vw]"
      >
        <MediaLibraryView variant="dialog" active={open} onSelect={onSelect} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
