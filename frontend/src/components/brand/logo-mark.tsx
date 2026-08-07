import { cn } from "@/lib/utils";

/**
 * Collapsed mark (model-selector pill, collapsed sidebar rail).
 * Plain <img>, not next/image — SVG optimization needs next.config.ts
 * changes (dangerouslyAllowSVG) that are out of scope for this pass.
 * dark:invert works because the asset is monochrome.
 */
export function LogoMark({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/vyomflow-mark.svg"
      alt=""
      width={size}
      height={size}
      className={cn("rounded dark:invert", className)}
    />
  );
}
