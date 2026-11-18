import { useState } from 'react'
import { readShowView } from '@orbital/shared/views'
import type { ChatMessage } from '../lib/types'
import { MediaViewer } from './MediaViewer'
import { ViewFrame } from './ViewFrame'

/**
 * A generated view in the transcript (spec 2026-11-18-generated-views-design
 * § In the transcript): the live frame at the session's height, and ⤢ into
 * the maximised media viewer (69d), which pages on through the session's
 * other media from it.
 */

/** What opening a view maximised needs to know. `messageId` is its call's message, for Show in transcript. */
export interface ViewMaximise {
  viewId: string
  toolUseId: string
  title: string
  messageId: string
}

export function ViewRow({
  sessionId,
  viewId,
  toolUse,
  toolResult,
  surface,
  offline,
  onMaximise,
}: {
  sessionId: string
  viewId: string
  toolUse: ChatMessage
  toolResult?: ChatMessage
  surface: 'panel' | 'phone'
  offline?: boolean
  /** The phone's own viewer; absent on the desktop, which opens its media viewer here. */
  onMaximise?: (view: ViewMaximise) => void
}) {
  const [maximised, setMaximised] = useState(false)
  const toolUseId = toolUse.toolUseId ?? ''
  const view: ViewMaximise = {
    viewId,
    toolUseId,
    title: readShowView(toolUse.toolInput)?.title ?? '',
    messageId: toolUse.id,
  }
  const maximise = onMaximise ? () => onMaximise(view) : surface === 'phone' ? undefined : () => setMaximised(true)
  return (
    <div data-view-call={toolUseId}>
      <ViewFrame
        sessionId={sessionId}
        toolUseId={toolUseId}
        surface={surface}
        onMaximise={maximise}
        resultAt={toolResult?.timestamp}
        offline={offline}
      />
      {!onMaximise && surface !== 'phone' && (
        <MediaViewer
          open={maximised}
          sessionId={sessionId}
          target={maximised ? { kind: 'view', ...view } : null}
          onClose={() => setMaximised(false)}
        />
      )}
    </div>
  )
}
