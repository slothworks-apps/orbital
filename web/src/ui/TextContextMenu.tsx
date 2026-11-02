import { createRoot, type Root } from 'react-dom/client'
import { canEdit, runEditCommand, type EditCommand } from '../lib/desktop'
import { ContextMenu } from './ContextMenu'
import { EscapeTopmost } from './escapeLayer'
import { MENU_SEPARATOR, type MenuEntry } from './Menu'
import { CopyGlyph, CutGlyph, PasteGlyph, SelectAllGlyph } from './UtilityButton'

/**
 * The context menu on selected text and in text fields (spec
 * 2026-11-02-text-context-menu-design, canvas `Feature - Path menu glyphs`
 * 1h). Electron draws no menu of its own, so without this a right-click on
 * either did nothing.
 *
 * One document listener for every window, installed once from `main.tsx`,
 * that runs after the owners' own handlers: an event a planet, a session row,
 * the media viewer or a path has already taken (`defaultPrevented`) is theirs.
 * The rows run the window's own edit commands through main, so they do
 * exactly what ⌘X, ⌘C, ⌘V and ⌘A do — the composer sees a real paste, and a
 * copy keeps the formatting ⌘C keeps.
 */

/** Input types that hold text a person types; the rest (a checkbox, a range) get no menu. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])

export type TextMenuTarget =
  | {
      kind: 'field'
      field: HTMLElement
      /** Something is selected in it: Cut and Copy can act. */
      selected: boolean
      /** Typing is allowed: Cut and Paste can act. */
      writable: boolean
      /** A password field: what it holds never leaves it. */
      secret: boolean
    }
  | { kind: 'selection' }

function isTextInput(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.getAttribute('type')?.toLowerCase() ?? '')
}

/** The field a right-click landed in: a text input, a textarea, or an editable region. */
function fieldAt(target: Element): HTMLElement | null {
  if (isTextInput(target) || target instanceof HTMLTextAreaElement) return target
  const editable = target.closest<HTMLElement>('[contenteditable]')
  return editable && isEditable(editable) ? editable : null
}

/**
 * `isContentEditable`, which also says no for a `contenteditable="false"`
 * island inside an editor (a mention chip). jsdom has no such property, so
 * the attribute stands in for it there.
 */
function isEditable(el: HTMLElement): boolean {
  return el.isContentEditable ?? el.getAttribute('contenteditable') !== 'false'
}

/** Whether a field has text selected in it. A number input has no selection range to ask. */
function fieldSelected(field: HTMLElement, selection: Selection | null): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    try {
      return field.selectionStart !== null && field.selectionStart !== field.selectionEnd
    } catch {
      return false
    }
  }
  return !!selection && !selection.isCollapsed && field.contains(selection.anchorNode) && field.contains(selection.focusNode)
}

function insideSelection(selection: Selection, x: number, y: number): boolean {
  for (let i = 0; i < selection.rangeCount; i += 1) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
    }
  }
  return false
}

/**
 * What a right-click at (`x`, `y`) on `target` is about, or null for nothing
 * this menu takes: a field, or a point inside the selection of a selectable
 * surface (`[data-selectable]`).
 */
export function textMenuTarget(target: EventTarget | null, x: number, y: number, selection: Selection | null): TextMenuTarget | null {
  if (!(target instanceof Element)) return null
  const field = fieldAt(target)
  if (field) {
    const readOnly =
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && (field.readOnly || field.disabled)
    return {
      kind: 'field',
      field,
      selected: fieldSelected(field, selection),
      writable: !readOnly,
      secret: field instanceof HTMLInputElement && field.type === 'password',
    }
  }
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const anchor = selection.anchorNode
  const surface = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[data-selectable]')
  if (!surface) return null
  return insideSelection(selection, x, y) ? { kind: 'selection' } : null
}

/** The rows for a target; `run` puts focus and selection back, then runs the command. */
export function textMenuEntries(target: TextMenuTarget, run: (command: EditCommand) => void): MenuEntry[] {
  const copy: MenuEntry = {
    key: 'copy',
    label: 'Copy',
    icon: <CopyGlyph />,
    detail: '⌘C',
    disabled: target.kind === 'field' && (!target.selected || target.secret),
    onSelect: () => run('copy'),
  }
  if (target.kind === 'selection') return [copy]
  return [
    {
      key: 'cut',
      label: 'Cut',
      icon: <CutGlyph />,
      detail: '⌘X',
      disabled: !target.selected || !target.writable || target.secret,
      onSelect: () => run('cut'),
    },
    copy,
    { key: 'paste', label: 'Paste', icon: <PasteGlyph />, detail: '⌘V', disabled: !target.writable, onSelect: () => run('paste') },
    MENU_SEPARATOR,
    { key: 'select-all', label: 'Select All', icon: <SelectAllGlyph />, detail: '⌘A', onSelect: () => run('selectAll') },
  ]
}

let root: Root | null = null
let installed = false

function close(): void {
  root?.render(null)
}

function open(event: MouseEvent, target: TextMenuTarget, selection: Selection | null): void {
  // Opening the menu moves focus into it, and an editor may drop its
  // selection when it loses focus: keep the ranges to put back before the
  // command runs, so it acts on what was selected at the right-click.
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  // An input or a textarea keeps its own selection, which focusing it brings back.
  const keepsOwn =
    target.kind === 'field' && (target.field instanceof HTMLInputElement || target.field instanceof HTMLTextAreaElement)
  const run = (command: EditCommand) => {
    if (target.kind === 'field') target.field.focus({ preventScroll: true })
    const now = document.getSelection()
    if (now && ranges.length && !keepsOwn) {
      now.removeAllRanges()
      for (const range of ranges) now.addRange(range)
    }
    runEditCommand(command)
  }
  if (!root) {
    const host = document.createElement('div')
    host.setAttribute('data-text-menu', '')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  root.render(
    <EscapeTopmost>
      <ContextMenu
        // A right-click elsewhere is a new opening, not a moved one.
        key={`${event.clientX},${event.clientY},${event.timeStamp}`}
        at={{ x: event.clientX, y: event.clientY }}
        entries={textMenuEntries(target, run)}
        aria-label={target.kind === 'field' ? 'Edit' : 'Selection'}
        onClose={close}
      />
    </EscapeTopmost>,
  )
}

/** Listens for right-clicks once per page; a no-op in a browser, where the browser's own menu stays. */
export function installTextMenu(): void {
  if (installed || !canEdit()) return
  installed = true
  document.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return
    const selection = document.getSelection()
    const target = textMenuTarget(event.target, event.clientX, event.clientY, selection)
    if (!target) return
    event.preventDefault()
    open(event, target, selection)
  })
}
