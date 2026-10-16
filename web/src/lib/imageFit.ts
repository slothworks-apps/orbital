import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MEDIA_TYPES } from './attachments'

/** The longest edge the API takes; a bigger image is brought down to it before anything else. */
export const IMAGE_MAX_EDGE = 8000
/** The quality a brought-down image is encoded at: plenty for a screenshot's text. */
export const IMAGE_FIT_QUALITY = 0.9
/** Tries before giving up on a size; each one aims below the ceiling from what the last one weighed. */
const FIT_TRIES = 6

/**
 * The scale of the next try: from what an encode at `scale` weighed, the one
 * that should land under `maxBytes` — bytes go with the area, so with the
 * square root — aimed a little low, and always smaller than the last.
 */
export function nextFitScale(scale: number, bytes: number, maxBytes: number): number {
  return Math.min(scale * 0.9, scale * Math.sqrt(maxBytes / bytes) * 0.95)
}

/** The first scale: whatever brings the longest edge to `IMAGE_MAX_EDGE`, and never up. */
export function firstFitScale(w: number, h: number): number {
  return Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h))
}

/**
 * An image as the composer sends it (spec 2026-10-16-image-sizes-design § 1):
 * as picked when the API takes it — one of its four types, at most
 * `ATTACHMENT_MAX_BYTES` — or brought down until it is, in WebP (which keeps
 * a screenshot's transparency) or JPEG where the browser cannot write WebP.
 * A type the browser can decode but the API does not (HEIC) is converted the
 * same way. Null when the browser cannot decode it at all.
 */
export async function fitImage(file: File, maxBytes: number = ATTACHMENT_MAX_BYTES): Promise<File | null> {
  if (file.size <= maxBytes && ATTACHMENT_MEDIA_TYPES.has(file.type)) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    let scale = firstFitScale(bitmap.width, bitmap.height)
    for (let i = 0; i < FIT_TRIES; i++) {
      const blob = await encode(bitmap, scale)
      if (!blob) return null
      if (blob.size <= maxBytes) {
        const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
        const name = (file.name || 'image').replace(/\.[^.]*$/, '') + `.${ext}`
        return new File([blob], name, { type: blob.type })
      }
      scale = nextFitScale(scale, blob.size, maxBytes)
    }
    return null
  } finally {
    bitmap.close()
  }
}

async function encode(bitmap: ImageBitmap, scale: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const as = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, IMAGE_FIT_QUALITY))
  // A browser that cannot write WebP answers PNG instead, which is no smaller.
  const webp = await as('image/webp')
  if (webp?.type === 'image/webp') return webp
  return as('image/jpeg')
}
