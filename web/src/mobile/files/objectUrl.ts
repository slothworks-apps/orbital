import { useEffect, useMemo } from 'react'

/**
 * A `blob:` URL for bytes the file resolver handed over, revoked when the
 * bytes change or the component goes. Shared by the viewer and the gate
 * card's thumbnails, which both draw a `FileOutcome`'s bytes.
 */
export function useObjectUrl(file: { bytes: Uint8Array; mediaType: string | null } | null): string | null {
  const url = useMemo(
    () => (file ? URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mediaType ?? '' })) : null),
    [file],
  )
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )
  return url
}
