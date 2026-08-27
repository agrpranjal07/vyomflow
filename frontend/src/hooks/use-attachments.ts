"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import Uppy from "@uppy/core";
import Transloadit from "@uppy/transloadit";
import { useApiClient } from "@/hooks/use-api-client";
import * as attachmentsService from "@/services/attachments";
import { ApiError } from "@/lib/api-client";
import { isInsufficientCredits } from "@/lib/credit-errors";
import { useCreditPaywall } from "@/components/credits/paywall-provider";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AllowedAttachmentMimeTypeSchema,
  type AttachmentDTO,
} from "@/contracts/attachments";
import type { z } from "zod";

type AllowedMimeType = z.infer<typeof AllowedAttachmentMimeTypeSchema>;

export type AttachmentItem = {
  attachmentId: string;
  /** Present only for a device-selected file mid-upload/retry; absent for a media-library pick. */
  file?: File;
  fileName: string;
  mimeType: string;
  status: "uploading" | "ready" | "failed";
  progress: number;
  resultUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);

function humanSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

/**
 * Owns one chat's in-flight/attached composer state (S4). One Uppy instance
 * is created per file — not one shared instance for the whole batch —
 * because @uppy/transloadit's `assemblyOptions` callback is invoked once
 * per Uppy instance and shared across every file added to it, which would
 * collapse independent per-file params/signature/cancel/retry into a single
 * Assembly. See the S4 frontend implementation plan.
 *
 * Takes a `getChatId` resolver rather than a raw chatId so the empty-state
 * composer (no chat exists yet) can attach without creating one — a chat
 * is only ever created on send (see empty-state.tsx's `pendingChatIdRef`),
 * never merely from attaching a file. The resolver returns `undefined`
 * until then; the backend accepts a chatless (draft) upload and binds it
 * to whichever chat the eventual send creates or reuses.
 */
export function useAttachments(getChatId: () => Promise<string | undefined>) {
  const fetcher = useApiClient();
  const { open: openPaywall } = useCreditPaywall();
  const [items, setItems] = useState<AttachmentItem[]>([]);
  // attachmentId -> live Uppy instance, kept only while its single upload is in flight (for cancel).
  const uppyInstances = useRef(new Map<string, Uppy>());

  const patch = useCallback((attachmentId: string, patchFields: Partial<AttachmentItem>) => {
    setItems((prev) => prev.map((it) => (it.attachmentId === attachmentId ? { ...it, ...patchFields } : it)));
  }, []);

  const runUpload = useCallback(
    (attachmentId: string, file: File, params: string, signature: string) => {
      const uppy = new Uppy({ autoProceed: false, restrictions: { maxNumberOfFiles: 1 } });
      uppyInstances.current.set(attachmentId, uppy);
      uppy.use(Transloadit, {
        waitForEncoding: false,
        assemblyOptions: () => ({ params, signature }),
      });

      let assemblyId: string | null = null;
      uppy.on("transloadit:assembly-created", (assembly) => {
        assemblyId = assembly.assembly_id ?? null;
      });
      uppy.on("upload-progress", (_file, progress) => {
        const total = progress.bytesTotal ?? file.size;
        const pct = total > 0 ? Math.round(((progress.bytesUploaded ?? 0) / total) * 100) : 0;
        patch(attachmentId, { progress: pct });
      });

      uppy.addFile({ name: file.name, type: file.type, data: file });

      uppy
        .upload()
        .then(async (result) => {
          uppyInstances.current.delete(attachmentId);
          if (!result || result.successful?.length !== 1 || !assemblyId) {
            const message = result?.failed?.[0]?.error ?? "Upload failed";
            patch(attachmentId, { status: "failed", errorMessage: message });
            return;
          }
          try {
            const dto = await attachmentsService.completeAttachment(fetcher, attachmentId, assemblyId);
            if (dto.status === "READY") {
              patch(attachmentId, {
                status: "ready",
                progress: 100,
                resultUrl: dto.resultUrl,
              });
            } else {
              patch(attachmentId, {
                status: "failed",
                errorCode: dto.errorCode,
                errorMessage: dto.errorMessage ?? "Processing failed",
              });
            }
          } catch (err) {
            patch(attachmentId, {
              status: "failed",
              errorMessage: err instanceof ApiError ? err.message : "Couldn't confirm upload",
            });
          }
        })
        .catch((err: unknown) => {
          uppyInstances.current.delete(attachmentId);
          patch(attachmentId, {
            status: "failed",
            errorMessage: err instanceof Error ? err.message : "Upload failed",
          });
        });
    },
    [fetcher, patch],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const availableSlots = MAX_ATTACHMENTS_PER_MESSAGE - items.length;
      if (availableSlots <= 0) {
        toast.warning("Too many attachments", {
          description: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        });
        return;
      }

      const candidates = files.slice(0, availableSlots);
      if (files.length > candidates.length) {
        toast.warning("Too many attachments", {
          description: `Only the first ${availableSlots} file(s) were added — the ${MAX_ATTACHMENTS_PER_MESSAGE}-file limit per message was reached.`,
        });
      }

      const valid: File[] = [];
      const rejected: string[] = [];
      for (const file of candidates) {
        if (!ALLOWED_MIME_SET.has(file.type)) {
          rejected.push(`${file.name} (unsupported file type)`);
          continue;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          rejected.push(`${file.name} (over ${humanSize(MAX_ATTACHMENT_BYTES)})`);
          continue;
        }
        valid.push(file);
      }
      if (rejected.length > 0) {
        toast.warning("Some files couldn't be added", { description: rejected.join(", ") });
      }
      if (valid.length === 0) return;

      try {
        const chatId = await getChatId();
        const response = await attachmentsService.requestUploadParams(fetcher, {
          chatId,
          files: valid.map((f) => ({ fileName: f.name, mimeType: f.type as AllowedMimeType, byteSize: f.size })),
        });
        setItems((prev) => [
          ...prev,
          ...response.uploads.map((upload, i) => ({
            attachmentId: upload.attachmentId,
            file: valid[i],
            fileName: valid[i]!.name,
            mimeType: valid[i]!.type,
            status: "uploading" as const,
            progress: 0,
            resultUrl: null,
            errorCode: null,
            errorMessage: null,
          })),
        ]);
        response.uploads.forEach((upload, i) => {
          runUpload(upload.attachmentId, valid[i]!, upload.params, upload.signature);
        });
      } catch (err) {
        if (isInsufficientCredits(err)) {
          openPaywall("upload");
        } else {
          toast.warning("Couldn't start upload", {
            description: err instanceof ApiError ? err.message : "Please try again.",
          });
        }
      }
    },
    [fetcher, getChatId, items.length, runUpload, openPaywall],
  );

  /** Adds an already-READY attachment picked from the media library (no upload needed). */
  const addExisting = useCallback(
    (attachment: AttachmentDTO) => {
      if (items.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        toast.warning("Too many attachments", {
          description: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        });
        return;
      }
      setItems((prev) => [
        ...prev,
        {
          attachmentId: attachment.id,
          fileName: attachment.fileName ?? "Attachment",
          mimeType: attachment.mimeType ?? "",
          status: "ready",
          progress: 100,
          resultUrl: attachment.resultUrl,
          errorCode: null,
          errorMessage: null,
        },
      ]);
    },
    [items.length],
  );

  const remove = useCallback(
    (attachmentId: string) => {
      const item = items.find((it) => it.attachmentId === attachmentId);
      setItems((prev) => prev.filter((it) => it.attachmentId !== attachmentId));
      const uppy = uppyInstances.current.get(attachmentId);
      if (uppy) {
        uppy.cancelAll();
        uppyInstances.current.delete(attachmentId);
      }
      // Only a still-PENDING (uploading) row is cancellable server-side; a
      // READY row left unbound simply becomes part of the user's media
      // library rather than an error (S4 design — no separate Library entity).
      if (item?.status === "uploading") {
        attachmentsService.cancelAttachment(fetcher, attachmentId).catch(() => {
          // Best-effort — the row is already gone from local state either way.
        });
      }
    },
    [fetcher, items],
  );

  const retry = useCallback(
    (attachmentId: string) => {
      const item = items.find((it) => it.attachmentId === attachmentId);
      if (!item?.file) return;
      patch(attachmentId, { status: "uploading", progress: 0, errorCode: null, errorMessage: null });
      getChatId()
        .then((chatId) =>
          attachmentsService.requestUploadParams(fetcher, {
            chatId,
            files: [
              { fileName: item.file!.name, mimeType: item.file!.type as AllowedMimeType, byteSize: item.file!.size },
            ],
          }),
        )
        .then((response) => {
          const upload = response.uploads[0];
          if (!upload) throw new Error("No upload params returned");
          // The retry mints a fresh Attachment row — swap the id in place.
          setItems((prev) =>
            prev.map((it) => (it.attachmentId === attachmentId ? { ...it, attachmentId: upload.attachmentId } : it)),
          );
          runUpload(upload.attachmentId, item.file!, upload.params, upload.signature);
        })
        .catch((err: unknown) => {
          patch(attachmentId, {
            status: "failed",
            errorMessage: err instanceof ApiError ? err.message : "Retry failed",
          });
        });
    },
    [fetcher, getChatId, items, patch, runUpload],
  );

  const reset = useCallback(() => {
    uppyInstances.current.forEach((uppy) => uppy.cancelAll());
    uppyInstances.current.clear();
    setItems([]);
  }, []);

  const readyAttachmentIds = items.filter((it) => it.status === "ready").map((it) => it.attachmentId);
  const hasUploading = items.some((it) => it.status === "uploading");

  return { items, addFiles, addExisting, remove, retry, reset, readyAttachmentIds, hasUploading };
}

export type UseAttachmentsResult = ReturnType<typeof useAttachments>;

/**
 * The caller's media library — every owned READY upload plus every
 * COMPLETED generated tool result, for the "Select Asset" picker and the
 * standalone Library page. `source` narrows to just one kind.
 */
export function useMediaLibrary(enabled: boolean, source: "all" | "uploaded" | "generated" = "all") {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: ["attachments", "library", source] as const,
    queryFn: () => attachmentsService.listAttachments(fetcher, { unbound: true, source, limit: 30 }),
    enabled,
  });
}
