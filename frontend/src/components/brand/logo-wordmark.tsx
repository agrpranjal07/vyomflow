import { cn } from "@/lib/utils";

/**
 * Sidebar wordmark, drawn as inline text (Outfit 600 "Vyom" + Outfit 400
 * "Flow") rather than an image asset. Size fills the existing brand-logo
 * box exactly — S-fidelity-ui.md §2.8.
 */
export function LogoWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block w-[var(--brand-logo-width)] h-[var(--brand-logo-height)] whitespace-nowrap font-sans text-[17px] leading-[20px] tracking-[-0.019em] text-foreground",
        className,
      )}
    >
      <span className="font-semibold">Vyom</span>
      <span className="font-normal">Flow</span>
    </span>
  );
}
