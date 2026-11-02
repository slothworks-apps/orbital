import { copyToClipboard } from '../../lib/clipboard'
import { configureFileOpen, type FileOpenTarget } from '../../lib/fileOpen'
import { useMobile } from '../state'
import { sessionDeviceName } from '../useDevice'
import { sessionServes } from '../version'
import { showFileChoice } from './FileChoiceSheet'
import './paths.css'

/**
 * Points the transcript's path and image presses at the phone's file screen
 * (spec 2026-10-05-mobile-next § 2): a press pushes `openFile` over the open
 * session, a long-press copies the path as written. Boot calls it once.
 * Nothing here asks the Mac to open anything (Decision 8).
 *
 * A bare file name is looked up first, against a Mac that serves the lookup
 * (`MAC_FEATURES.findByName`); its matches, or the fact that there are none,
 * open the 1f sheet (spec 2026-11-02-bare-file-names-and-path-menu-design §
 * The phone). Against an older Mac it stays text.
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
    // The session's device's version, else the default member's — what `sessionSupports` reads, selected as one boolean.
    useFindsByName: (bare) =>
      useMobile((s) => bare && sessionServes('findByName', s.sessionId, undefined, s.devices, s.macVersion) === true),
    choose: (shown) => {
      const sessionId = useMobile.getState().sessionId
      const { choice } = shown
      // The phone names its Mac as everywhere else, not the session's machine alone.
      const device = choice.kind === 'silent' && sessionId ? sessionDeviceName(sessionId) : null
      showFileChoice(choice.kind === 'silent' && device ? { ...shown, choice: { ...choice, device } } : shown)
    },
  })
}

/** The pushed file screen's item for a press. */
export function fileItem(sessionId: string, target: FileOpenTarget) {
  return target.kind === 'path'
    ? { sessionId, path: target.path, line: target.line, messageId: target.messageId, ...(target.cwd ? { cwd: target.cwd } : {}) }
    : { sessionId, path: null, line: null, ref: target.ref, messageId: target.messageId }
}
