import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE } from '../constants'
import { fitWithin, photoName } from '../photo'

export type PhotoSource = 'camera' | 'gallery'
/**
 * The photo as it goes to the chip row: already downscaled, and — only when it
 * was — the size it was taken at (9b's chip meta "W×H → sent at …"). An
 * unscaled photo carries no `original`, so its chip reads as the desktop's.
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
  return downscale(picked.blob, picked.name)
}

type Picked = { blob: Blob; name: string | null }

async function fromPlugin(source: PhotoSource): Promise<Picked | 'cancelled' | 'denied'> {
  let photo
  try {
    photo = await Camera.getPhoto({
      source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.Uri,
      // Full quality in: the one re-encode is ours, at `PHOTO_JPEG_QUALITY`.
      quality: 100,
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
  return { blob: blob.type ? blob : new Blob([blob], { type: `image/${photo.format}` }), name: null }
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

async function downscale(blob: Blob, name: string | null): Promise<PickedPhoto> {
  const bitmap = await createImageBitmap(blob)
  try {
    const original = { w: bitmap.width, h: bitmap.height }
    const fit = fitWithin(original.w, original.h, PHOTO_MAX_EDGE)
    if (!fit.scaled) return { file: new File([blob], name ?? photoName(new Date()), { type: blob.type }) }
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
    return { file: new File([jpeg], fileName, { type: jpeg.type }), original }
  } finally {
    bitmap.close()
  }
}
