"use client";

import { MediaLibraryView } from "@/components/chat/media-library-view";

/** Standalone Library page (reference: the reference product's /library page) — reached from the sidebar's "Library" nav row, not a popup. */
export default function LibraryPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
      <MediaLibraryView variant="page" active />
    </div>
  );
}
