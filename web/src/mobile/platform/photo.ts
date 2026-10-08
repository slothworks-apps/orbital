import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE, PHOTO_PLUGIN_EDGE } from '../constants'
import { fitWithin, photoName, takenSize } from '../photo'

export type PhotoSource = 'camera' | 'gallery'
/**
 * The photo as it goes to the chip row: already downscaled, and — only when it
 * was — the size it was taken at (9b's chip meta "W×H → sent at …"). An
 * unscaled photo carries no `original`, so its chip reads as the desktop's;
 * so does a scaled one whose taken size nothing reports.
 */
export type PickedPhoto = { file: File; original?: { w: number; h: number } }

/**
 * One photo from the camera or the gallery (spec § 6.2), downscaled to
 * `PHOTO_MAX_EDGE`. A desktop browser — the dev build, the fidelity pass —
 * gets a file input instead of the plugin. A failure that is neither a
 * cancel nor a refused permission rejects.
 */
export async function pickPhoto(source: PhotoSource): Promise<PickedPhoto | 'cancelled' | 'denied'> {
  const picked = Capacitor.isNativePlatform() ? await fromPlugin(source) : await fromInput(source)
  if (typeof picked === 'string') return picked
  const { file, bitmap, sent } = await downscale(picked.blob, picked.name)
  // A browser's file is the photo as taken: its bitmap says the size.
  if (picked.exif === undefined) return sent ? { file, original: bitmap } : { file }
  // The plugin's is already brought down: the size taken comes from its exif,
  // or from the bitmap when the plugin had nothing to bring down.
  const taken = takenSize(picked.exif, bitmap) ?? (Math.max(bitmap.w, bitmap.h) < PHOTO_PLUGIN_EDGE ? bitmap : null)
  const out = sent ?? bitmap
  return taken && Math.max(taken.w, taken.h) > Math.max(out.w, out.h) ? { file, original: taken } : { file }
}

/** `exif` is the plugin's, absent for a browser's file. */
type Picked = { blob: Blob; name: string | null; exif?: unknown }

async function fromPlugin(source: PhotoSource): Promise<Picked | 'cancelled' | 'denied'> {
  let photo
  try {
    photo = await Camera.getPhoto({
      source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.Uri,
      // Full quality in: the one re-encode that counts is ours, at `PHOTO_JPEG_QUALITY`.
      quality: 100,
      // Brought down in the plugin, so a very large shot never reaches the
      // WebView (or the plugin's own encode) at full size.
      width: PHOTO_PLUGIN_EDGE,
      height: PHOTO_PLUGIN_EDGE,
      allowEditing: false,
      correctOrientation: true,
      saveToGallery: false,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The plugin's own words: "User cancelled photos app", "User denied access to camera".
    if (/cancel/i.test(message)) return 'cancelled'
    if (/denied|permission/i.test(message)) return 'denied'
    throw err
  }
  if (!photo.webPath) throw new Error('the camera returned no photo')
  const blob = await (await fetch(photo.webPath)).blob()
  // A file URL can come back untyped; the plugin still names the format.
  const typed = blob.type ? blob : new Blob([blob], { type: `image/${photo.format}` })
  return { blob: typed, name: null, exif: photo.exif ?? null }
}

/** A desktop browser: the system's file dialog, a closed one read as cancelled. */
function fromInput(source: PhotoSource): Promise<Picked | 'cancelled'> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (source === 'camera') input.setAttribute('capture', 'environment')
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      resolve(file ? { blob: file, name: file.name } : 'cancelled')
    })
    input.addEventListener('cancel', () => resolve('cancelled'))
    input.click()
  })
}

type Size = { w: number; h: number }

/** The file to send, the size of the bitmap it came from, and — when brought down — the size it went at. */
async function downscale(blob: Blob, name: string | null): Promise<{ file: File; bitmap: Size; sent: Size | null }> {
  const bitmap = await createImageBitmap(blob)
  try {
    const size = { w: bitmap.width, h: bitmap.height }
    const fit = fitWithin(size.w, size.h, PHOTO_MAX_EDGE)
    if (!fit.scaled) return { file: new File([blob], name ?? photoName(new Date()), { type: blob.type }), bitmap: size, sent: null }
    const canvas = document.createElement('canvas')
    canvas.width = fit.w
    canvas.height = fit.h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas to downscale on')
    ctx.drawImage(bitmap, 0, 0, fit.w, fit.h)
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY))
    if (!jpeg) throw new Error('the downscaled photo could not be encoded')
    // A browser file keeps its name, with the extension its new bytes have.
    const fileName = name ? name.replace(/\.[^.]*$/, '') + '.jpg' : photoName(new Date())
    return { file: new File([jpeg], fileName, { type: jpeg.type }), bitmap: size, sent: { w: fit.w, h: fit.h } }
  } finally {
    bitmap.close()
  }
}
