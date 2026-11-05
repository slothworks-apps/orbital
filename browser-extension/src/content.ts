/**
 * Runs in every page. Sends the end of a selection to the service worker;
 * nothing else, and never on Orbital's own pages.
 */

import { LOCAL_KEYS, parsePort, type WorkerMessage } from './messages'
import { createSelectionEndDetector, DEFAULT_ORBITAL_PORT, isOrbitalPage } from './selection'

/** The selection, including one inside a text field, which `getSelection` does not see. */
function readSelection(): string {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
    const { selectionStart, selectionEnd, value } = el
    if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
      return value.slice(selectionStart, selectionEnd)
    }
  }
  return window.getSelection()?.toString() ?? ''
}

function send(text: string): void {
  const message: WorkerMessage = {
    kind: 'selection',
    text,
    url: location.href,
    title: document.title,
  }
  try {
    // No answer is expected; a worker that is gone (the extension reloaded) is fine.
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // "Extension context invalidated": this page outlived a reload of the extension.
  }
}

async function start(): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.port)
  if (isOrbitalPage(location, parsePort(stored[LOCAL_KEYS.port], DEFAULT_ORBITAL_PORT))) return

  const detector = createSelectionEndDetector({ read: readSelection, send })
  document.addEventListener('selectionchange', detector.onSelectionChange)
  window.addEventListener('select', detector.onSelectionChange, true)
  window.addEventListener('mousedown', detector.onPointerDown, true)
  window.addEventListener('mouseup', detector.onPointerUp, true)
  window.addEventListener('keyup', detector.onKeyUp, true)
}

void start()
