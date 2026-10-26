/** Best-effort copy. `navigator.clipboard` is absent in jsdom and on any
 * non-secure origin, and a copy button that throws is not a trade worth
 * making. Resolves to whether the text actually landed on the clipboard. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    console.error('orbital: could not copy to the clipboard', err)
    return false
  }
}

/**
 * An image's bytes to the clipboard, by the URL it is drawn from. Chromium's
 * async clipboard takes `image/png` alone, so anything else is drawn into a
 * canvas and re-encoded first. Resolves to whether it landed, as above.
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false
    const response = await fetch(url)
    if (!response.ok) return false
    const blob = await response.blob()
    const png = blob.type === 'image/png' ? blob : await reencodeAsPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch (err) {
    console.error('orbital: could not copy the image to the clipboard', err)
    return false
  }
}

/** Any image the browser can decode, as PNG. An SVG is drawn at its own size. */
async function reencodeAsPng(blob: Blob): Promise<Blob> {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')?.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('the image would not encode as PNG'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
