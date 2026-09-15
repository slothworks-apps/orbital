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

let body: THREE.Texture | null | undefined

/**
 * Planet body disc, per the canvas export's inline CSS:
 * `radial-gradient(circle at 50% 45%, oklch(30% .05 220), oklch(20% .04 225) 70%, oklch(16% .03 230))`.
 * Neutral (not tag-hued) and state-independent, so one shared texture.
 */
export function bodyTexture(): THREE.Texture | null {
  if (body !== undefined) return body
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    body = null
    return body
  }
  const cx = size * 0.5
  const cy = size * 0.45
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.62)
  try {
    gradient.addColorStop(0, 'oklch(30% 0.05 220)')
    gradient.addColorStop(0.7, 'oklch(20% 0.04 225)')
    gradient.addColorStop(1, 'oklch(16% 0.03 230)')
  } catch {
    // Older canvas without oklch() parsing — close sRGB approximations.
    gradient.addColorStop(0, '#20303f')
    gradient.addColorStop(0.7, '#111c28')
    gradient.addColorStop(1, '#0b141d')
  }
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  body = new THREE.CanvasTexture(canvas)
  body.colorSpace = THREE.SRGBColorSpace
  return body
}
