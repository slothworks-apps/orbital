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

let nebula: THREE.Texture | null | undefined

/**
 * Faint blue-teal nebula clouds on transparent black, per artboard 1a.
 * Blob positions are fixed (not random) so the backdrop is stable across
 * mounts and sessions.
 */
export function nebulaTexture(): THREE.Texture | null {
  if (nebula !== undefined) return nebula
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    nebula = null
    return nebula
  }
  const blobs: Array<{ x: number; y: number; r: number; color: string }> = [
    { x: 0.32, y: 0.38, r: 0.45, color: 'rgba(38, 70, 120, 0.16)' },
    { x: 0.72, y: 0.24, r: 0.35, color: 'rgba(24, 90, 110, 0.12)' },
    { x: 0.62, y: 0.72, r: 0.5, color: 'rgba(46, 58, 110, 0.14)' },
    { x: 0.15, y: 0.78, r: 0.3, color: 'rgba(20, 80, 95, 0.1)' },
  ]
  for (const blob of blobs) {
    const gradient = ctx.createRadialGradient(
      blob.x * size,
      blob.y * size,
      0,
      blob.x * size,
      blob.y * size,
      blob.r * size
    )
    gradient.addColorStop(0, blob.color)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
  }
  nebula = new THREE.CanvasTexture(canvas)
  return nebula
}
