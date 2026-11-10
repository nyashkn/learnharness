import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";

/**
 * The confidence slider row, shared by the quiz dock and the practice dock
 * (lh-g5b) so the two controls cannot drift: a range input snapping to
 * CONFIDENCE_STOPS over the painted rail (see confidence-rail.tsx for the
 * geometry/stacking laws). `disabled` grays it out and shows "—" (the quiz's
 * "I don't know"). Keyboard ←/→ is the quiz dock machine's, not here.
 */
export function ConfidenceSlider({
	index,
	onIndexChange,
	disabled = false,
	ariaLabel,
	title,
}: {
	index: number;
	onIndexChange: (index: number) => void;
	disabled?: boolean;
	ariaLabel: string;
	title: string;
}) {
	return (
		<div className="flex items-center gap-3">
			<span
				className={cn(
					"shrink-0 text-xs font-medium uppercase tracking-wide",
					disabled ? "text-muted-foreground/50" : "text-muted-foreground",
				)}
			>
				Confidence
			</span>
			<div className={cn("relative h-4 min-w-0 flex-1", disabled && "opacity-40")} data-testid="confidence-track">
				{/* The RAIL is painted here, not on the input: this overlay spans exactly the
					thumb-CENTER range (inset 8px = half the 16px disc), so the disc at 0 and 100
					sits flush against the rail's ends. Both layers are absolute with the input
					later in the DOM, so the disc rides on top; h-4 pins the shared box. */}
				<div
					aria-hidden
					data-testid="confidence-rail"
					className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
					style={confidenceRailStyle(CONFIDENCE_STOPS[index]!)}
				/>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={CONFIDENCE_STOPS[index]}
					disabled={disabled}
					aria-label={ariaLabel}
					aria-valuetext={`${CONFIDENCE_STOPS[index]} percent`}
					title={title}
					data-testid="confidence-slider"
					onChange={(e) => {
						// Snap to the nearest stop; the rendered VALUE is the stop's own percent.
						const v = Number(e.target.value);
						let best = 0;
						for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
							if (Math.abs(CONFIDENCE_STOPS[i]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = i;
						}
						onIndexChange(best);
					}}
					style={{ color: CONFIDENCE_COLORS[index] }}
					className={cn(
						"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
						"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
						"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
						"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
						"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
					)}
				/>
			</div>
			<span
				data-testid="confidence-value"
				className={cn("w-9 shrink-0 text-right font-mono text-sm tabular-nums", disabled && "text-muted-foreground/50")}
			>
				{disabled ? "—" : `${CONFIDENCE_STOPS[index]}%`}
			</span>
		</div>
	);
}
