import { copyToClipboard } from '../../lib/clipboard'
import { configureFileOpen, type FileOpenTarget } from '../../lib/fileOpen'
import { useMobile } from '../state'
import './paths.css'

/**
 * Points the transcript's path and image presses at the phone's file screen
 * (spec 2026-10-05-mobile-next § 2): a press pushes `openFile` over the open
 * session, a long-press copies the path as written. Boot calls it once.
 * Nothing here asks the Mac to open anything (Decision 8).
 */
export function installFileOpen(): void {
  configureFileOpen({
    open: (target) => {
      const sessionId = useMobile.getState().sessionId
      if (sessionId) useMobile.getState().openFile(fileItem(sessionId, target))
    },
    longPress: (path) => {
      void copyToClipboard(path)
    },
  })
}

/** The pushed file screen's item for a press. */
export function fileItem(sessionId: string, target: FileOpenTarget) {
  return target.kind === 'path'
    ? { sessionId, path: target.path, line: target.line, messageId: target.messageId }
    : { sessionId, path: null, line: null, ref: target.ref, messageId: target.messageId }
}
