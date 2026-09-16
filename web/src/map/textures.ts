import * as THREE from 'three'

/**
 * Procedural CanvasTextures for the map's soft-light elements (planet halo
 * glow, nebula backdrop). Generated once per session and shared — planets
 * tint the same white glow via material color, so hue still comes only from
 * the tag. Returns null where a 2D canvas context is unavailable (jsdom
 * tests); callers fall back to flat, textureless materials.
 */

let glow: THREE.Texture | null | undefined

/** Radial white→transparent glow. Tint via the material's `color`. */
export function glowTexture(): THREE.Texture | null {
  if (glow !== undefined) return glow
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    glow = null
    return glow
  }
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.4)')
  gradient.addColorStop(0.65, 'rgba(255,255,255,0.12)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  glow = new THREE.CanvasTexture(canvas)
  return glow
}

/**
 * Builds one `radial-gradient(circle at 50% 45%, …)` body disc. `stops` are
 * `[offset, oklch(), sRGB fallback]` triples — the fallback is used where the
 * canvas implementation cannot parse `oklch()` colour strings.
 */
function bodyGradient(stops: [number, string, string][]): THREE.Texture | null {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const gradient = ctx.createRadialGradient(size * 0.5, size * 0.45, 0, size * 0.5, size * 0.45, size * 0.62)
  try {
    for (const [offset, oklch] of stops) gradient.addColorStop(offset, oklch)
  } catch {
    // Older canvas without oklch() parsing — close sRGB approximations.
    for (const [offset, , fallback] of stops) gradient.addColorStop(offset, fallback)
  }
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

let body: THREE.Texture | null | undefined

/**
 * Working planet body, per the canvas export's inline CSS (1a/1c/1f/2d):
 * `radial-gradient(circle at 50% 45%, oklch(30% .05 220), oklch(20% .04 225) 70%, oklch(16% .03 230))`.
 * Neutral (not tag-hued) and state-independent, so one shared texture.
 */
export function bodyTexture(): THREE.Texture | null {
  if (body !== undefined) return body
  body = bodyGradient([
    [0, 'oklch(30% 0.05 220)', '#20303f'],
    [0.7, 'oklch(20% 0.04 225)', '#111c28'],
    [1, 'oklch(16% 0.03 230)', '#0b141d'],
  ])
  return body
}

let bodyIdle: THREE.Texture | null | undefined

/**
 * Idle / needs-input planet body — the export uses a distinctly darker,
 * two-stop gradient for these states (1f, 1a, 2d):
 * `radial-gradient(circle at 50% 45%, oklch(28% .05 220), oklch(18% .04 225) 70%)`.
 */
export function bodyIdleTexture(): THREE.Texture | null {
  if (bodyIdle !== undefined) return bodyIdle
  bodyIdle = bodyGradient([
    [0, 'oklch(28% 0.05 220)', '#1d2c3a'],
    [0.7, 'oklch(18% 0.04 225)', '#0e1924'],
    [1, 'oklch(18% 0.04 225)', '#0e1924'],
  ])
  return bodyIdle
}
