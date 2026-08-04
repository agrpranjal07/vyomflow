"use client";

import { useEffect, useState } from "react";

/**
 * Small time label above the empty-state heading ("3:38 PM" style — h:mm
 * plus a smaller AM/PM), reference-observed above "Your AI worker"
 * (S-fidelity-ui.md typography scale; exact caption weight not separately
 * measured, so this reuses the existing muted-caption token pairing).
 * Client-only real time — rendered after mount to avoid an SSR/client
 * timestamp mismatch.
 */
export function EmptyStateClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // One-time client-only read of the real time to avoid an SSR/client
    // mismatch — not a subscription, so there's nothing to tick/update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
  }, []);

  if (!now) return null;

  const hours24 = now.getHours();
  const hours12 = hours24 % 12 || 12;
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const period = hours24 >= 12 ? "PM" : "AM";

  return (
    <span className="text-sm font-medium text-text-secondary">
      {hours12}:{minutes}
      <span className="text-xs">{period}</span>
    </span>
  );
}
