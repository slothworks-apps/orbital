import { createPortal } from 'react-dom'
import type { SessionHarness } from '../../lib/types'
import { ConfirmSheet } from '../ui'
import { goBackLines } from './gate'

/**
 * Go back asks first (canvas 10b second phone; spec § 1): which step, what
 * the conversation does, that the commits stay in git. While something runs
 * it says that stops too, as the desktop's dialog does.
 */
export function GoBackSheet({
  harness,
  index,
  running,
  onConfirm,
  onCancel,
}: {
  harness: SessionHarness
  index: number
  running: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const lines = goBackLines(harness, index, running)
  // Out of the transcript: a fixed sheet inside its scroller (a clip, maybe a transform) would be cut away.
  return createPortal(
    <ConfirmSheet
      eyebrow={lines.eyebrow}
      title={lines.title}
      body={lines.body}
      detail={lines.detail.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
      confirmLabel={lines.confirm}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
    document.body,
  )
}
