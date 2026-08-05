"use client";

import { useMemo, useRef, useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Uppy from "@uppy/core";
import Transloadit from "@uppy/transloadit";
import {
  IconCheck,
  IconDownload,
  IconFile,
  IconMusic,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "@tabler/icons-react";
import { classifyAssetUrl } from "@/components/chat/generated-asset";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SquareCheckbox } from "@/components/ui/square-checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useApiClient } from "@/hooks/use-api-client";
import { useMediaLibrary } from "@/hooks/use-attachments";
import * as attachmentsService from "@/services/attachments";
import { ApiError } from "@/lib/api-client";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  type AllowedAttachmentMimeTypeSchema,
  type AttachmentDTO,
} from "@/contracts/attachments";
import type { z } from "zod";

type AllowedMimeType = z.infer<typeof AllowedAttachmentMimeTypeSchema>;
const ALLOWED_MIME_SET = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);
const ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(",");

function dateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** Items arrive newest-first (ListAttachmentsQuerySchema), so same-label rows are already adjacent. */
function groupByDate(items: AttachmentDTO[]): { label: string; items: AttachmentDTO[] }[] {
  const groups: { label: string; items: AttachmentDTO[] }[] = [];
  for (const item of items) {
    const label = dateLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/**
 * Card-overlay checkbox chip — 28x28/10px-radius, translucent dark bg in
 * both states (rgba(10,10,11,.5) live-measured), only the check glyph
 * toggles: an empty outline when unselected, a filled white check when
 * selected.
 */
function ChipCheckbox({ checked, onClick, className }: { checked: boolean; onClick: (e: MouseEvent) => void; className?: string }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e as unknown as MouseEvent);
        }
      }}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-black/50 transition-opacity",
        className,
      )}
    >
      {checked ? (
        <IconCheck className="size-3.5 text-white" strokeWidth={3} />
      ) : (
        <span className="size-3 rounded-[3px] border-[1.5px] border-white/80" />
      )}
    </span>
  );
}

function MediaCard({
  attachment,
  selected,
  selectionActive,
  onToggleSelect,
  onSelect,
}: {
  attachment: AttachmentDTO;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: () => void;
  onSelect: () => void;
}) {
  // Generated items (contracts/attachments.ts's AttachmentSourceSchema) carry
  // no mimeType — fall back to the same URL-extension classification
  // generated-asset.tsx already uses to render them inline in chat.
  const urlKind = attachment.resultUrl ? classifyAssetUrl(attachment.resultUrl) : null;
  const format = attachment.mimeType?.split("/")[1]?.toUpperCase() ?? urlKind?.toUpperCase() ?? "FILE";
  const isImage = attachment.mimeType?.startsWith("image/") || urlKind === "image";
  const isVideo = attachment.mimeType?.startsWith("video/") || urlKind === "video";
  const isAudio = attachment.mimeType?.startsWith("audio/") || urlKind === "audio";
  return (
    <button
      type="button"
      onClick={() => (selectionActive ? onToggleSelect() : onSelect())}
      title={attachment.fileName ?? undefined}
      className="group relative aspect-[191/128] overflow-hidden rounded-sm bg-surface-thumbnail"
    >
      {isImage && attachment.resultUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- backend-hosted result URL, not a next/image remote-pattern candidate.
        <img src={attachment.resultUrl} alt={attachment.fileName ?? ""} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center">
          {isVideo ? (
            <IconVideo className="size-6 text-text-secondary" />
          ) : isAudio ? (
            <IconMusic className="size-6 text-text-secondary" />
          ) : (
            <IconFile className="size-6 text-text-secondary" />
          )}
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[45px] bg-gradient-to-t from-black/60 to-transparent" />
      <div className="absolute inset-x-2 bottom-1.5 flex items-center gap-1.5">
        <span className="shrink-0 rounded-[4px] bg-black/50 px-1 py-0.5 text-[10px] font-medium text-white">{format}</span>
        <span className="truncate text-xs leading-4 text-white">{attachment.fileName ?? "Untitled"}</span>
      </div>
      <ChipCheckbox
        checked={selected}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        // Live reference: the chip is hidden until hover, but becomes
        // permanently visible on every card the instant selection mode
        // starts (not just the hovered one) — see reference-media-library-desktop.md.
        className={cn("absolute left-2 top-2 opacity-0 group-hover:opacity-100", selectionActive && "opacity-100")}
      />
    </button>
  );
}

/**
 * Shared Media Library implementation — grid/search/upload/multi-select
 * download+delete — used both inside the attach-menu's "Select Asset"
 * Dialog (`variant="dialog"`) and as the standalone `/library` page
 * (`variant="page"`). Chrome measured directly from the reference product's own
 * DOM/computed styles, not estimated — see
 * .claude/evidence/reference-media-library-desktop.md (dialog chrome) and
 * .claude/evidence/reference-tasks-page-desktop.md (page-header chrome,
 * shared pattern with the Tasks page). Sort, Filter, Favorites, the
 * Generated tab, a My-folders sidebar, and the share/favorite selection-bar
 * icons are deliberately not built: none has a backing entity/field in
 * this project's Attachment model — only Search, Upload Media, and
 * multi-select download/delete are real, data-backed features.
 */
export function MediaLibraryView({
  variant,
  active,
  onSelect,
  onClose,
}: {
  variant: "dialog" | "page";
  /** Whether the view is actually visible/mounted — gates the data fetch (dialog: `open`; page: always true). */
  active: boolean;
  /** Omitted for the standalone page — a card click there only toggles selection. */
  onSelect?: (attachment: AttachmentDTO) => void;
  /** Dialog only. */
  onClose?: () => void;
}) {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState<"all" | "uploaded" | "generated">("all");
  const { data, isLoading, isFetching, refetch } = useMediaLibrary(active, sourceFilter);
  const [query, setQuery] = useState("");
  const [uploadingCount, setUploadingCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => data?.items ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => (it.fileName ?? "").toLowerCase().includes(q));
  }, [items, query]);
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroupSelect(groupItems: AttachmentDTO[]) {
    const allSelected = groupItems.every((it) => selectedIds.has(it.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      groupItems.forEach((it) => (allSelected ? next.delete(it.id) : next.add(it.id)));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setConfirmingDelete(false);
  }

  function downloadSelected() {
    const toDownload = items.filter((it) => selectedIds.has(it.id) && it.resultUrl);
    toDownload.forEach((attachment, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = attachment.resultUrl!;
        a.download = attachment.fileName ?? "download";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Staggered — firing every download in the same tick trips the browser's popup blocker.
      }, i * 150);
    });
  }

  async function confirmDelete() {
    // Generated items have no Attachment row to delete — they're a
    // read-only projection of a ToolInvocation result (contracts/attachments.ts's
    // AttachmentSourceSchema doc comment). Skip them here rather than firing
    // a DELETE that can only ever 404.
    const selected = items.filter((it) => selectedIds.has(it.id));
    const ids = selected.filter((it) => it.source === "uploaded").map((it) => it.id);
    const skipped = selected.length - ids.length;
    setConfirmingDelete(false);
    const results = await Promise.allSettled(ids.map((id) => attachmentsService.deleteAttachment(fetcher, id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    queryClient.invalidateQueries({ queryKey: ["attachments", "library"] });
    clearSelection();
    if (failed > 0) {
      toast.warning("Some files couldn't be deleted", {
        description: `${failed} of ${ids.length} file${ids.length === 1 ? "" : "s"} failed to delete.`,
      });
    } else if (ids.length > 0) {
      toast.success(`Deleted ${ids.length} file${ids.length === 1 ? "" : "s"}`);
    }
    if (skipped > 0) {
      toast.info(`${skipped} generated item${skipped === 1 ? "" : "s"} can't be deleted directly — it's part of a chat's tool result.`);
    }
  }

  function uploadFiles(files: File[]) {
    const valid = files.filter((f) => ALLOWED_MIME_SET.has(f.type) && f.size <= MAX_ATTACHMENT_BYTES);
    if (valid.length === 0) {
      toast.warning("Couldn't upload", { description: "Unsupported file type or file too large." });
      return;
    }
    setUploadingCount((n) => n + valid.length);
    attachmentsService
      .requestUploadParams(fetcher, {
        files: valid.map((f) => ({ fileName: f.name, mimeType: f.type as AllowedMimeType, byteSize: f.size })),
      })
      .then((response) => {
        response.uploads.forEach((upload, i) => {
          const file = valid[i]!;
          const uppy = new Uppy({ autoProceed: false, restrictions: { maxNumberOfFiles: 1 } });
          uppy.use(Transloadit, {
            waitForEncoding: false,
            assemblyOptions: () => ({ params: upload.params, signature: upload.signature }),
          });
          let assemblyId: string | null = null;
          uppy.on("transloadit:assembly-created", (assembly) => {
            assemblyId = assembly.assembly_id ?? null;
          });
          uppy.addFile({ name: file.name, type: file.type, data: file });
          uppy
            .upload()
            .then(async (result) => {
              if (!result || result.successful?.length !== 1 || !assemblyId) {
                throw new Error(result?.failed?.[0]?.error ?? "Upload failed");
              }
              await attachmentsService.completeAttachment(fetcher, upload.attachmentId, assemblyId);
              queryClient.invalidateQueries({ queryKey: ["attachments", "library"] });
            })
            .catch((err: unknown) => {
              toast.warning("Upload failed", {
                description: err instanceof Error ? err.message : "Please try again.",
              });
            })
            .finally(() => setUploadingCount((n) => n - 1));
        });
      })
      .catch((err: unknown) => {
        setUploadingCount((n) => n - valid.length);
        toast.warning("Couldn't start upload", {
          description: err instanceof ApiError ? err.message : "Please try again.",
        });
      });
  }

  const selectionActive = selectedIds.size > 0;
  const allSelected = filtered.length > 0 && filtered.every((it) => selectedIds.has(it.id));
  const countLabel = uploadingCount > 0
    ? `Uploading ${uploadingCount} file${uploadingCount === 1 ? "" : "s"}…`
    : `${items.length} file${items.length === 1 ? "" : "s"}`;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", variant === "dialog" && "gap-0")}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) uploadFiles(files);
        }}
      />

      {variant === "dialog" ? (
        // Inset gray panel — measured against the attach-menu's own popup chrome.
        <div className="relative m-4 mb-5 shrink-0 rounded-xl bg-surface-inset p-4">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 flex size-7 items-center justify-center rounded-full text-text-secondary hover:bg-black/5"
            >
              <IconX className="size-4" />
            </button>
          )}
          <p className="text-sm font-semibold text-text-primary">Media Library</p>
          <p className="text-xs text-text-secondary">{countLabel}</p>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex h-12 flex-1 items-center gap-3 rounded-xl border border-[#8a8a8a] bg-surface-inset px-5">
              <IconSearch className="size-4 shrink-0 text-text-secondary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts & file names…"
                className="h-full flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => refetch()}
              aria-label="Refresh"
              className="size-12 shrink-0 rounded-sm bg-white hover:bg-white/80"
            >
              <IconRefresh className={cn("size-4", isFetching && "animate-spin")} />
            </Button>
            {selectionActive && onSelect ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      onClick={() => {
                        for (const id of selectedIds) {
                          const attachment = items.find((it) => it.id === id);
                          if (attachment) onSelect(attachment);
                        }
                        setSelectedIds(new Set());
                        onClose?.();
                      }}
                      className="h-12 w-[172px] shrink-0 gap-2 rounded-xl bg-surface-dark text-sm font-semibold text-white hover:opacity-90"
                    />
                  }
                >
                  <IconPlus className="size-4" />
                  Add to Chat
                </TooltipTrigger>
                <TooltipContent>Add selected media to chat</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="h-12 w-[172px] shrink-0 gap-2 rounded-xl bg-surface-dark text-sm font-semibold text-white hover:opacity-90"
              >
                <IconUpload className="size-4" />
                Upload Media
              </Button>
            )}
          </div>
        </div>
      ) : (
        // Plain page header — same title scale as the Tasks page
        // (30px/700), directly on the page background, no inset card.
        <div className="shrink-0 px-1 pb-5">
          <h1 className="text-[30px] font-bold leading-9 text-text-primary">Library</h1>
          <p className="text-xs text-text-secondary">{countLabel}</p>
          <div className="mt-4 flex items-center gap-3">
            <div className="relative flex-1">
              <IconSearch className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts & file names…"
                className="h-[34px] w-full rounded-pill bg-surface-inset pl-10 pr-4 text-sm text-text-primary outline-none placeholder:text-text-secondary"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => refetch()}
              aria-label="Refresh"
              className="size-9 shrink-0 rounded-sm border-border-secondary bg-[#fafafa]"
            >
              <IconRefresh className={cn("size-4", isFetching && "animate-spin")} />
            </Button>
            <Button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="h-9 shrink-0 gap-2 rounded-pill bg-action-primary-bg px-3.5 text-sm font-medium text-action-primary-fg hover:opacity-90"
            >
              <IconUpload className="size-4" />
              Upload Media
            </Button>
          </div>
        </div>
      )}

      <div className={cn("flex shrink-0 items-center gap-1.5 pb-3", variant === "dialog" ? "px-4" : "px-1")}>
        {(["all", "uploaded", "generated"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSourceFilter(option)}
            aria-pressed={sourceFilter === option}
            className={cn(
              "rounded-pill px-3 py-1 text-xs font-medium capitalize transition-colors",
              sourceFilter === option
                ? "bg-surface-dark text-white"
                : "bg-surface-inset text-text-secondary hover:text-text-primary",
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", variant === "dialog" ? "px-4 pb-4" : "px-1")}>
        {isLoading ? (
          <p className="p-4 text-sm text-text-secondary">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-text-secondary">
            {query ? "No files match your search." : "No files yet — upload something to get started."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => {
              const groupAllSelected = group.items.every((it) => selectedIds.has(it.id));
              return (
                <div key={group.label} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-text-primary">{group.label}</span>
                      <span className="text-[#5e5e5e]">
                        {group.items.length} Item{group.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <SquareCheckbox checked={groupAllSelected} onClick={() => toggleGroupSelect(group.items)} />
                  </div>
                  <div className={cn("grid gap-2", variant === "dialog" ? "grid-cols-3" : "grid-cols-5")}>
                    {group.items.map((attachment) => (
                      <MediaCard
                        key={attachment.id}
                        attachment={attachment}
                        selected={selectedIds.has(attachment.id)}
                        selectionActive={selectionActive}
                        onToggleSelect={() => toggleSelect(attachment.id)}
                        onSelect={() => onSelect?.(attachment)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectionActive && (
        // 84px tall, white bg, 1px hairline top border, 40px horizontal
        // padding — live-measured against the reference's own selection bar.
        <div
          className={cn(
            "flex h-[84px] shrink-0 items-center justify-between border-t border-border-hairline bg-white px-10",
            variant === "page" && "-mx-1",
          )}
        >
          <div className="flex items-center gap-3">
            <SquareCheckbox checked={allSelected} onClick={() => toggleGroupSelect(filtered)} />
            <span className="text-sm text-text-primary">{selectedIds.size} Selected</span>
            <Button type="button" variant="ghost" size="sm" onClick={clearSelection} className="rounded-pill text-[#5e5e5e]">
              Clear Selection
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={downloadSelected}
              aria-label="Download selected"
              className="size-7 rounded-full bg-white text-text-information hover:bg-black/5"
            >
              <IconDownload className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setConfirmingDelete(true)}
              aria-label="Delete selected"
              className="size-7 rounded-full bg-white text-destructive hover:bg-black/5"
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete-confirmation modal — 512px/16px-radius/24px-padding card,
          measured live against the reference's own "Delete Selected Items"
          dialog (reference-media-library-desktop.md). */}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent showCloseButton={false} className="w-[512px] max-w-[90vw] gap-4 rounded-2xl bg-white p-6 ring-0">
          <p className="text-lg font-semibold text-text-primary">Delete Selected Items</p>
          <p className="text-sm leading-5 text-text-secondary">
            Are you sure you want to delete {selectedIds.size === 1 ? "this item" : `these ${selectedIds.size} items`}? It
            will be permanently removed from all locations.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-pill border-border-hairline text-[#181818] hover:bg-black/5"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-9 rounded-pill bg-[#b42318] text-[#f7f7f7] hover:bg-[#b42318]/90"
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
