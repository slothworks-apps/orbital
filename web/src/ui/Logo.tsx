import { useId } from 'react'

/**
 * Orbital mark: the orbit ring with a body on its near side, shared by the
 * expanded sidebar header and the collapsed rail. Geometry and gradients are
 * `assets/orbital-mark.svg` from the canvas `App Icon - A front` (LEFT MENU
 * MARK), verbatim — the same drawing as the app icon and favicon with the
 * tile and the SVG glow filter dropped.
 *
 * The ambient glow is a CSS `drop-shadow` rather than an `feGaussianBlur` so
 * it can be dropped for a menu-bar template image, where the OS wants flat
 * artwork. `MARK SIZES` on that artboard rules out anything below 14px: the
 * body merges into the ring. Both placements here use the 18px size.
 */
export function Logo() {
  // Both call sites (header and rail) are mounted at once, so the gradient
  // ids have to be per-instance. useId's colons are legal in an id but not
  // worth the url(#…) footgun.
  const uid = useId().replace(/:/g, '')
  const ring = `mr-${uid}`
  const halo = `mg-${uid}`

  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="18"
      height="18"
      className="block shrink-0 drop-shadow-[0_0_8px_rgba(110,211,239,.45)]"
    >
      <defs>
        <linearGradient id={ring} x1="0.85" y1="0.1" x2="0.15" y2="0.95">
          <stop offset="0" stopColor="#d7f4ff" />
          <stop offset="0.5" stopColor="#6ed3ef" />
          <stop offset="1" stopColor="#3f9fc0" />
        </linearGradient>
        <radialGradient id={halo} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.3" stopColor="#96e1ff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#78c8f0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="12" cy="12" r="7.6" fill="none" stroke={`url(#${ring})`} strokeWidth="1.6" />
      <circle cx="17.7" cy="6.9" r="4.6" fill={`url(#${halo})`} />
      <circle cx="17.7" cy="6.9" r="2.5" fill="#cdf1ff" />
    </svg>
  )
}
