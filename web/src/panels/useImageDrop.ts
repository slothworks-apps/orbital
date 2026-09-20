import { useEffect, useRef, useState } from 'react'
import { dragCarriesImages, filesFrom } from '../lib/attachments'

/**
 * How long a `dragleave` is given to turn out to have been a crossing rather
 * than a departure (canvas 9e drop state: "a 80 ms grace so crossing a child
 * element never flickers").
 *
 * The grace is what makes a whole panel usable as one drop target: `dragenter`
 * and `dragleave` fire for every descendant the pointer passes over, so the
 * naive "leave disarms" reads a drag travelling across the transcript as a
 * dozen departures.
 */
export const DROP_LEAVE_GRACE_MS = 80

export interface ImageDrop {
  /** True while a drag carrying images is over the target. */
  armed: boolean
  /**
   * Attach to the drop target. A CALLBACK ref, not a `useRef` object, and that
   * is load-bearing: the detail panel mounts and unmounts with the selection, so
   * an effect keyed on a ref object would bind its listeners on the one render
   * where the element did not exist yet and never look again.
   */
  ref: (element: HTMLElement | null) => void
}

/**
 * Arms the drop state for a whole surface — the panel in the detail mount, the
 * dialog surface in the other (spec: 2026-09-20-composer-design § Image
 * intake). The caller paints itself with `armed` and hands it to `Composer`,
 * which turns the well into the marker.
 *
 * Listeners are attached imperatively rather than through React props for two
 * reasons: the target is an ancestor the composer does not own, and `dragover`
 * must be `preventDefault`ed or the browser navigates to the dropped file.
 *
 * A drag carrying no image files never arms and is never prevented, so a drag
 * that belongs to something else (a tag rule being reordered, text out of the
 * transcript) behaves exactly as it did before this hook existed.
 */
export function useImageDrop(onFiles: (files: File[]) => void): ImageDrop {
  const [armed, setArmed] = useState(false)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  /** The callback is read through a ref so re-renders never re-bind listeners. */
  const handler = useRef(onFiles)
  handler.current = onFiles

  useEffect(() => {
    if (!target) return
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const cancelGrace = () => {
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    }

    const onDragEnter = (event: DragEvent) => {
      if (!dragCarriesImages(event.dataTransfer)) return
      event.preventDefault()
      cancelGrace()
      setArmed(true)
    }

    const onDragOver = (event: DragEvent) => {
      if (!dragCarriesImages(event.dataTransfer)) return
      // Without this the drop never reaches us at all.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      cancelGrace()
    }

    const onDragLeave = (event: DragEvent) => {
      if (!dragCarriesImages(event.dataTransfer)) return
      cancelGrace()
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        setArmed(false)
      }, DROP_LEAVE_GRACE_MS)
    }

    const onDrop = (event: DragEvent) => {
      if (!dragCarriesImages(event.dataTransfer)) return
      event.preventDefault()
      cancelGrace()
      setArmed(false)
      // Every file, not only the images: the non-images are what the refusal
      // line is for, and dropping them silently would be the "can't drop that"
      // the canvas rules out — after the fact instead of before it.
      handler.current(filesFrom(event.dataTransfer))
    }

    target.addEventListener('dragenter', onDragEnter)
    target.addEventListener('dragover', onDragOver)
    target.addEventListener('dragleave', onDragLeave)
    target.addEventListener('drop', onDrop)
    return () => {
      cancelGrace()
      target.removeEventListener('dragenter', onDragEnter)
      target.removeEventListener('dragover', onDragOver)
      target.removeEventListener('dragleave', onDragLeave)
      target.removeEventListener('drop', onDrop)
    }
  }, [target])

  return { armed, ref: setTarget }
}
