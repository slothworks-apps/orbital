/**
 * Shared open/close motion.
 *
 * Easing is the export's panel curve, `cubic-bezier(.2,.8,.2,1)` — the same
 * one the sidebar collapses on and the rules list opens its drag gap with, so
 * every surface in the app decelerates the same way.
 *
 * Exits run shorter than entrances: an entrance is the app presenting
 * something and can afford to be seen, while an exit is the user having
 * already moved on, where the same duration reads as lag.
 *
 * The durations are duplicated as numbers because `usePresence` needs them in
 * JS (to know how long to keep the node mounted) and Tailwind needs them as
 * literal class names — v4 cannot build a class from a runtime value.
 */
export const MODAL_ENTER_MS = 180
export const MODAL_EXIT_MS = 140

/** The docked detail panel travels its whole width, so it gets longer than a modal. */
export const PANEL_ENTER_MS = 320
export const PANEL_EXIT_MS = 240

/**
 * The sidebar's collapse and expand: `Panel`'s width transition and the
 * content layer's cross-fade (`duration-[420ms]` in both). JS needs it to know
 * when an expand has finished — the traffic lights come back only then
 * (canvas `Feature - Main window chrome` 24b).
 */
export const SIDEBAR_COLLAPSE_MS = 420

const EASE = 'motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]'

/**
 * `motion-safe:` on the transition only — the open/closed styles themselves
 * stay ungated, so under `prefers-reduced-motion` a surface still appears and
 * disappears, just instantly. `usePresence` collapses its timers to match, so
 * a reduced-motion user never waits out an animation they cannot see.
 */
/**
 * `translate` and `scale` are listed separately on purpose. Tailwind v4's
 * `translate-x-*` / `scale-*` utilities set the standalone `translate` and
 * `scale` CSS properties, NOT `transform` — so a transition that only names
 * `transform` silently animates nothing, and the surface jumps into place
 * while the opacity fades. `transform` stays in the list for any hand-written
 * transform a caller might add.
 */
const ANIMATED = 'transition-[opacity,transform,translate,scale]'

export const MODAL_TRANSITION = `motion-safe:${ANIMATED} ${EASE}`
export const PANEL_TRANSITION = `motion-safe:${ANIMATED} ${EASE}`

export const MODAL_ENTER_DURATION = 'motion-safe:duration-[180ms]'
export const MODAL_EXIT_DURATION = 'motion-safe:duration-[140ms]'
export const PANEL_ENTER_DURATION = 'motion-safe:duration-[320ms]'
export const PANEL_EXIT_DURATION = 'motion-safe:duration-[240ms]'

/** Modal dialog: fades and lifts very slightly, never enough to read as a zoom. */
export const MODAL_CLOSED = 'opacity-0 scale-[.97]'
export const MODAL_OPEN = 'opacity-100 scale-100'

/** Scrim behind a modal — fades only; scaling a full-viewport backdrop would shimmer. */
export const SCRIM_CLOSED = 'opacity-0'
export const SCRIM_OPEN = 'opacity-100'

/**
 * A surface on its way out is still in the DOM, and must stop behaving like a
 * live one — otherwise a click aimed at what is behind it lands on the fading
 * overlay instead. Pair with the `inert` attribute so it also leaves the focus
 * order and the accessibility tree for those last few frames.
 */
export const EXITING = 'pointer-events-none'

/**
 * Detail panel: slides clear of the right edge. 100% of its own width plus the
 * 16px inset App docks it at, so nothing peeks out mid-transition.
 */
export const PANEL_CLOSED = 'opacity-0 translate-x-[calc(100%+16px)]'
export const PANEL_OPEN = 'opacity-100 translate-x-0'
