import * as THREE from 'three'
import { rgbCss, type Rgb, type SceneColours } from '../lib/sceneColours'

/**
 * Procedural CanvasTextures for the map's soft-light elements (planet halo
 * glow, the body discs). Shared — planets tint the same white glow via
 * material color, so hue still comes only from the tag; the glow is a mask,
 * white in every colour theme, while the body discs are painted from the
 * theme's palette. Returns null where a 2D canvas context is unavailable
 * (jsdom tests); callers fall back to flat, textureless materials.
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

let shadow: THREE.Texture | null | undefined

/**
 * A soft disc for the drop shadow a light theme puts under a body (1l:
 * `0 2px 8px` shadow): opaque out to `SHADOW_SOLID` of its radius, then
 * fading to nothing at the edge. White, tinted by the material's colour like
 * the glow. Sized by the caller so the fade spans the shadow's blur.
 */
export const SHADOW_SOLID = 0.72

export function shadowTexture(): THREE.Texture | null {
  if (shadow !== undefined) return shadow
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    shadow = null
    return shadow
  }
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(SHADOW_SOLID, 'rgba(255,255,255,1)')
  gradient.addColorStop((SHADOW_SOLID + 1) / 2, 'rgba(255,255,255,0.45)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  shadow = new THREE.CanvasTexture(canvas)
  return shadow
}

/**
 * Builds one `radial-gradient(circle at 50% 45%, …)` body disc from
 * `[offset, colour]` stops.
 */
function bodyGradient(stops: [number, Rgb][]): THREE.Texture | null {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const gradient = ctx.createRadialGradient(size * 0.5, size * 0.45, 0, size * 0.5, size * 0.45, size * 0.62)
  for (const [offset, colour] of stops) gradient.addColorStop(offset, rgbCss(colour))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * A body texture per colour theme: built for the palette it is asked with,
 * and rebuilt — the old one disposed — when the theme changes. Every planet
 * shares the one texture of the theme it paints in.
 */
function themedTexture(build: (palette: SceneColours) => THREE.Texture | null) {
  let made: { palette: SceneColours; texture: THREE.Texture | null } | null = null
  return (palette: SceneColours): THREE.Texture | null => {
    if (made?.palette === palette) return made.texture
    made?.texture?.dispose()
    made = { palette, texture: build(palette) }
    return made.texture
  }
}

/**
 * Working planet body, per the canvas export's inline CSS (1a/1c/1f/2d):
 * `radial-gradient(circle at 50% 45%, oklch(30% .05 220), oklch(20% .04 225) 70%, oklch(16% .03 230))`,
 * the theme's `body-hi`, `body-mid` and `body-lo`.
 * Neutral (not tag-hued) and state-independent, so one shared texture.
 */
export const bodyTexture = themedTexture(({ rgb }) =>
  bodyGradient([
    [0, rgb['body-hi']],
    [0.7, rgb['body-mid']],
    [1, rgb['body-lo']],
  ])
)

/**
 * Idle / needs-input planet body — the export uses a distinctly darker,
 * two-stop gradient for these states (1f, 1a, 2d):
 * `radial-gradient(circle at 50% 45%, oklch(28% .05 220), oklch(18% .04 225) 70%)` —
 * the theme's `body-idle-hi` and `body-idle-lo`.
 */
export const bodyIdleTexture = themedTexture(({ rgb }) =>
  bodyGradient([
    [0, rgb['body-idle-hi']],
    [0.7, rgb['body-idle-lo']],
  ])
)
