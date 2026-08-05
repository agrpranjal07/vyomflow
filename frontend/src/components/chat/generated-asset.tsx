"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders a tool's `resultUrls` as inline media — image, video, or audio,
 * inferred from the file extension (crop_image/generate_image return
 * image URLs, merge_videos returns a video URL; the DTO carries no explicit
 * media kind — assignment §6 "render the returned image_url/video_url as a
 * generated asset"). Split out from ToolCard per ui-architecture-policy.md
 * ("generated asset" is a named example of a meaningful component
 * boundary) since it's reused for both the tool card's own `Output` row and
 * the assistant message's rendered-asset area
 * (.claude/evidence/chat--video-player-card--desktop.png shows both).
 */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function extensionOf(url: string): string {
  return url.split("?")[0]?.toLowerCase() ?? "";
}

function matchesExtension(url: string, extensions: string[]): boolean {
  const path = extensionOf(url);
  return extensions.some((ext) => path.endsWith(ext));
}

/**
 * Strict URL classification for deciding whether an arbitrary link (e.g. in
 * the assistant's own markdown prose — message-content.tsx) should be
 * upgraded to inline media. Deliberately conservative: unlike
 * `GeneratedAsset`'s own "try image, fall back to link" behavior (safe only
 * because its inputs are always known tool `resultUrls`), an ordinary
 * link with an unrecognized/missing extension must stay a plain link here —
 * misclassifying it as an image would silently break normal links in
 * assistant text.
 */
export function classifyAssetUrl(url: string): "video" | "audio" | "image" | null {
  if (matchesExtension(url, VIDEO_EXTENSIONS)) return "video";
  if (matchesExtension(url, AUDIO_EXTENSIONS)) return "audio";
  if (matchesExtension(url, IMAGE_EXTENSIONS)) return "image";
  return null;
}

export function GeneratedAsset({ url, className }: { url: string; className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const commonClasses = cn("max-h-80 w-auto max-w-full rounded-[var(--radius-sm)] object-contain", className);

  if (matchesExtension(url, VIDEO_EXTENSIONS)) {
    return <video src={url} controls className={commonClasses} />;
  }
  if (matchesExtension(url, AUDIO_EXTENSIONS)) {
    return <audio src={url} controls className={cn("w-full max-w-full", className)} />;
  }
  // Recognized image extension, or an unrecognized/extensionless URL — most tool outputs are
  // images, so try rendering as one; if that fails, fall back to a plain link rather than a
  // silently-broken empty box (a user should never see "just a dead link with nothing to click").
  if (!imageFailed) {
    // A <span>, not a <div>: this can render inside markdown's <p> (CustomImg in
    // message-content.tsx), where a block-level div triggers the browser's auto-close-<p>
    // behavior and a React hydration mismatch. `flex flex-col` still applies to inline elements
    // once `display` is overridden.
    return (
      <span className="flex flex-col items-start gap-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- external, Transloadit-hosted result URLs; next/image's remote-pattern allowlist isn't worth maintaining for arbitrary generated-asset hosts. */}
        <img
          src={url}
          alt="Generated result"
          className={commonClasses}
          onError={() => setImageFailed(true)}
          onLoad={(e) =>
            setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
          }
        />
        {/* Dimension caption only once loaded — no placeholder, no layout shift (reference: "1024 X 1536"). */}
        {dimensions && (
          <span className="text-[10px] text-text-secondary">
            {dimensions.width} X {dimensions.height}
          </span>
        )}
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-text-secondary underline">
      Open result ↗
    </a>
  );
}

export function GeneratedAssetList({ urls, className }: { urls: string[]; className?: string }) {
  if (urls.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {urls.map((url) => (
        <GeneratedAsset key={url} url={url} />
      ))}
    </div>
  );
}
