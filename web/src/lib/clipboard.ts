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
