"use client";

import { useRef, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { IconPaperclip, IconPhotoPlus, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaLibraryDialog } from "@/components/chat/media-library-dialog";
import { ALLOWED_ATTACHMENT_MIME_TYPES } from "@/contracts/attachments";
import type { AttachmentDTO } from "@/contracts/attachments";

const ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(",");

/**
 * Paperclip button + popover ("Select Asset" / "Upload"), matching
 * .claude/evidence/composer--attachment-menu--desktop.png.
 */
export function AttachButton({
  onFilesSelected,
  onLibrarySelect,
  disabled,
}: {
  onFilesSelected: (files: File[]) => void;
  onLibrarySelect: (attachment: AttachmentDTO) => void;
  disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isSignedIn } = useAuth();
  const { openSignIn } = useClerk();

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFilesSelected(files);
        }}
      />
      <Popover
        open={menuOpen}
        onOpenChange={(next) => {
          // Guests can see the composer but attaching requires an owned
          // chat — open Clerk's sign-in modal instead of the menu.
          if (next && !isSignedIn) {
            openSignIn();
            return;
          }
          setMenuOpen(next);
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={disabled}
                    className="size-8 shrink-0 rounded-[var(--radius-pill)] text-text-secondary"
                    aria-label="Add attachment"
                  />
                }
              >
                <IconPaperclip className="size-4" />
              </PopoverTrigger>
            }
          />
          <TooltipContent>Attach files</TooltipContent>
        </Tooltip>
        {/* Chrome measured directly from the reference product's own DOM/computed
            styles (.claude/evidence/reference-media-library-desktop.md), not
            estimated from screenshots — overridden locally since no other
            popover's reference evidence calls for the same values. Panel:
            246px, 20px radius, 1px #ededed border, #f1f1f1 bg, 16px padding,
            12px gap. Buttons: 40px tall, 10px radius (--radius-sm, not a
            pill), 10px/16px padding, 8px icon gap. */}
        <PopoverContent
          align="start"
          className="w-[246px] gap-3 rounded-[20px] border border-border-hairline bg-surface-thumbnail p-4 shadow-[0_24px_32px_-8px_rgba(26,26,24,0.12),0_8px_12px_-6px_rgba(26,26,24,0.06)] ring-0"
        >
          <p className="text-xs font-medium text-text-primary">Add a file from your device or select one from your library</p>
          <Button
            variant="secondary"
            className="h-10 w-full justify-start rounded-[var(--radius-sm)] bg-surface-inset px-4 hover:bg-surface-inset/80"
            onClick={() => {
              setMenuOpen(false);
              setLibraryOpen(true);
            }}
          >
            <IconPhotoPlus className="size-4" />
            Select Asset
          </Button>
          <Button
            className="h-10 w-full justify-start rounded-[var(--radius-sm)] bg-action-primary-bg px-4 font-semibold text-action-primary-fg hover:opacity-90"
            onClick={() => {
              setMenuOpen(false);
              inputRef.current?.click();
            }}
          >
            <IconPlus className="size-4" />
            Upload
          </Button>
        </PopoverContent>
      </Popover>
      <MediaLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onSelect={(attachment) => {
          onLibrarySelect(attachment);
          setLibraryOpen(false);
        }}
      />
    </>
  );
}
