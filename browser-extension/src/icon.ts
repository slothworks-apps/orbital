/**
 * The toolbar icon, drawn from the app icon's A · front mark (canvas 64h):
 * a navy tile, the accent orbit, the body in front of it. One drawing for
 * both uses — `scripts/render-icons.mjs` renders the manifest's PNGs from
 * it, and the worker draws the outcome badge's frames with it.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type IconSize = 16 | 32 | 48 | 128

/**
 * Geometry per size, from the canvas: tile corner radius, ring inset and
 * width, body box and its tile-coloured gap, the tile's rim. Below 48 px
 * the ring and body grow relative to the tile so the mark reads at 16.
 */
const GEOMETRY: Record<IconSize, {
  rad: number
  ri: number
  rw: number
  bs: number
  bx: number
  by: number
  gap: number
  rim: number
}> = {
  16: { rad: 3.6, ri: 2.8, rw: 1.5, bs: 4.6, bx: 8.9, by: 2.6, gap: 1, rim: 0.6 },
  32: { rad: 7.2, ri: 6.2, rw: 2.2, bs: 7, bx: 18.9, by: 6.6, gap: 1.3, rim: 0.8 },
  48: { rad: 10.8, ri: 9.6, rw: 2.8, bs: 9.6, bx: 28.7, by: 10.3, gap: 1.6, rim: 1 },
  128: { rad: 28.8, ri: 26.5, rw: 6.5, bs: 21, bx: 78.6, by: 30.1, gap: 3.5, rim: 1.5 },
}

// The canvas's oklch values in sRGB, so any canvas context parses them.
/** oklch(86% .12 205) */
const RING = '#5de8f6'
/** oklch(78% .12 205), the body's shaded edge */
const BODY_EDGE = '#3bcddc'
/** The tile colour of the gap between body and ring. */
const GAP = '#142240'
/** oklch(85% .12 205), the accent: delivered. */
const BADGE_OK = '#59e4f3'
/** Neutral grey: not delivered. Never red. */
const BADGE_NOT = '#a3adbd'
const BADGE_INK = '#03111a'

export interface IconBadge {
  ok: boolean
  /** 0–1; the badge fades by opacity only. */
  opacity: number
}

/** Draws the mark at `size` px into `ctx`, with the outcome badge when given. */
export function drawIcon(ctx: Ctx, size: IconSize, badge?: IconBadge): void {
  const g = GEOMETRY[size]
  const s = size
  ctx.clearRect(0, 0, s, s)

  // The tile: linear-gradient(165deg, #1d2f4e, #0a1120 55%, #04070e).
  const angle = (165 * Math.PI) / 180
  const dx = Math.sin(angle)
  const dy = -Math.cos(angle)
  const half = (Math.abs(s * dx) + Math.abs(s * dy)) / 2
  const tile = ctx.createLinearGradient(s / 2 - dx * half, s / 2 - dy * half, s / 2 + dx * half, s / 2 + dy * half)
  tile.addColorStop(0, '#1d2f4e')
  tile.addColorStop(0.55, '#0a1120')
  tile.addColorStop(1, '#04070e')
  ctx.fillStyle = tile
  ctx.beginPath()
  ctx.roundRect(0, 0, s, s, g.rad)
  ctx.fill()

  // The rim: an inset hairline of white at .14.
  ctx.save()
  ctx.clip()
  ctx.strokeStyle = 'rgba(255,255,255,.14)'
  ctx.lineWidth = g.rim * 2
  ctx.beginPath()
  ctx.roundRect(0, 0, s, s, g.rad)
  ctx.stroke()
  ctx.restore()

  // The orbit: a circle inset by `ri`, its border `rw` wide.
  ctx.strokeStyle = RING
  ctx.lineWidth = g.rw
  ctx.beginPath()
  ctx.arc(s / 2, s / 2, s / 2 - g.ri - g.rw / 2, 0, Math.PI * 2)
  ctx.stroke()

  // The body, in front of the orbit, held off it by a tile-coloured gap.
  const r = g.bs / 2
  const cx = g.bx + r
  const cy = g.by + r
  ctx.fillStyle = GAP
  ctx.beginPath()
  ctx.arc(cx, cy, r + g.gap, 0, Math.PI * 2)
  ctx.fill()
  // radial-gradient(circle at 34% 30%, #fff, #b7ecff 45%, oklch(78% .12 205)),
  // sized to the farthest corner of its box.
  const hx = g.bx + 0.34 * g.bs
  const hy = g.by + 0.3 * g.bs
  const body = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.hypot(0.66, 0.7) * g.bs)
  body.addColorStop(0, '#ffffff')
  body.addColorStop(0.45, '#b7ecff')
  body.addColorStop(1, BODY_EDGE)
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  if (badge && badge.opacity > 0) drawBadge(ctx, s, badge)
}

/**
 * The badge, drawn at the 16 px canvas's proportions: a 9.5 px disc with a
 * 1.5 px ring cut out of the mark, so the toolbar shows through whatever its
 * colour. The canvas lets the disc hang past the tile's corner; an icon
 * image cannot draw past its edge, so here the disc sits inside it.
 */
function drawBadge(ctx: Ctx, s: number, badge: IconBadge): void {
  const unit = s / 16
  const d = 9.5 * unit
  const ring = 1.5 * unit
  const cx = s - d / 2
  const cy = s - d / 2
  ctx.save()
  ctx.globalAlpha = badge.opacity
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2 + ring, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = badge.ok ? BADGE_OK : BADGE_NOT
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.fill()

  // The glyph, stroked: no font is guaranteed inside a worker.
  const x0 = cx - d / 2
  const y0 = cy - d / 2
  ctx.strokeStyle = BADGE_INK
  ctx.lineWidth = 0.13 * d
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (badge.ok) {
    ctx.moveTo(x0 + 0.29 * d, y0 + 0.52 * d)
    ctx.lineTo(x0 + 0.44 * d, y0 + 0.67 * d)
    ctx.lineTo(x0 + 0.72 * d, y0 + 0.35 * d)
  } else {
    ctx.moveTo(x0 + 0.34 * d, y0 + 0.34 * d)
    ctx.lineTo(x0 + 0.66 * d, y0 + 0.66 * d)
    ctx.moveTo(x0 + 0.66 * d, y0 + 0.34 * d)
    ctx.lineTo(x0 + 0.34 * d, y0 + 0.66 * d)
  }
  ctx.stroke()
  ctx.restore()
}
