/**
 * Empty-state mascot. Three passes of the mark's own channel path
 * (M7 1.5 -> 16 21.5 -> 25 10, scaled into the 120 viewBox), descending
 * and fading toward the leading accent-colored pass. Stroke weight is
 * tuned for the component's actual 40px render size, not the 120 viewBox.
 */
export function Mascot({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      // 10px symmetric padding beyond the 0-120 path box — the leading
      // pass's round linecap at (26,5) with strokeWidth 15 (7.5px radius)
      // extends to y ≈ -2.5, which the un-padded viewBox was clipping.
      viewBox="-10 -10 140 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* trailing pass, furthest back — most faded */}
      <path
        d="M26 5 L60 80.5 L94 37"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(0 24)"
      />
      {/* trailing pass, middle */}
      <path
        d="M26 5 L60 80.5 L94 37"
        stroke="currentColor"
        strokeOpacity="0.38"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(0 12)"
      />
      {/* leading pass — the live channel, in accent. currentColor + the
          text-primary utility reads the centralized --primary token
          (globals.css), so light/dark both come from the single token
          source rather than a second hardcoded copy of its value. */}
      <path
        d="M26 5 L60 80.5 L94 37"
        stroke="currentColor"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-primary"
      />
    </svg>
  );
}
