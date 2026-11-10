import { cn } from "@/utils/cn";
import { brandDisplayClass } from "./font";
import { BraintreeMark } from "./BraintreeMark";
import { Mascot } from "./Mascot";
import type { MascotCycle } from "./mascotFrames";

/**
 * The Braintree Reach logo — the one source for the app chrome and the login
 * screen. The tree is ./BraintreeMark.tsx; the favicon (src/app/icon.svg,
 * apple-icon.png) is the same tree drawn as static files; change them together.
 */

/** The icon tile's corner radius. */
export const ICON_RADIUS = "14%";

/** How a logo's mascot moves: a walk cycle, looping or only while its `.group` is hovered. */
export type Walk = { walk?: MascotCycle; walkOn?: "always" | "hover" };

/**
 * The Braintree tree on a solid tile that inverts with the theme (dark tile,
 * light tree; light tile, dark tree in dark mode), like SecureTrace's mark.
 * `small`, `walk` and `walkOn` are kept so callers stay unchanged; the tree
 * does not animate.
 */
export function AppIcon({ className }: { className?: string; small?: boolean } & Walk) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0 items-center justify-center bg-bg-strong-950 text-text-white-0", className)}
      // A square tile with gently rounded corners, not an app-store squircle.
      style={{ borderRadius: ICON_RADIUS }}
    >
      <BraintreeMark className="size-[62%]" />
    </span>
  );
}

/** The mascot alone, standing, in currentColor: the mark without its tile. */
export function AgentMark({ className }: { className?: string }) {
  return <Mascot className={className} />;
}

/**
 * Tile and name together. The name takes the surrounding text colour, so
 * it follows the theme; pass a colour in `className` on fixed backgrounds.
 */
export function Logo({
  className,
  iconClassName = "size-7",
  textClassName = "text-[19px]",
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
} & Walk) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <AppIcon small className={iconClassName} />
      <span className={cn(brandDisplayClass, "whitespace-nowrap leading-none tracking-[-0.025em]", textClassName)}>Braintree Reach</span>
    </span>
  );
}
