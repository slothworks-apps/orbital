import { act } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import { composerMarkdown } from '../lib/composerMarkdown'

/**
 * Getting text into the composer in tests (spec:
 * 2026-09-29-composer-rich-editor-design § 5).
 *
 * The field is a ProseMirror editor, not a textarea: there is no `value` to
 * read and `fireEvent.change` means nothing to it, and user-event's typing into
 * a contenteditable depends on jsdom's selection doing what a browser's does.
 * These go through the editor instead — the way a keyboard does, so the
 * markdown input rules still fire — and read back the markdown the composer
 * hands its caller.
 */

/** Tiptap hangs the editor off its root element. */
export function editorOf(field: HTMLElement): Editor {
  const editor = (field as HTMLElement & { editor?: Editor }).editor
  if (!editor) throw new Error('not a composer field')
  return editor
}

/** What `toHaveValue` read off the textarea: the markdown the field hands out. */
export function fieldValue(field: HTMLElement): string {
  return composerMarkdown(editorOf(field))
}

/** Puts the caret in the field, at the end of what is there. */
export function focusField(field: HTMLElement): void {
  // Straight to the view: the `focus` command waits a frame, and a test does not.
  const { view } = editorOf(field)
  act(() => {
    view.focus()
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)))
  })
}

/**
 * Types at the caret, one character at a time. Each is offered to the
 * editor's text-input handlers first — which is where the input rules live
 * (`- `, `**…**`) — and inserted plainly when none of them takes it.
 */
export function typeInto(field: HTMLElement, text: string): void {
  const { view } = editorOf(field)
  for (const ch of text) {
    act(() => {
      const { from, to } = view.state.selection
      const insert = () => view.state.tr.insertText(ch, from, to)
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert))
      if (!handled) view.dispatch(insert())
    })
  }
}

/** Focuses the field and types, the way a user clicks in and starts typing. */
export function clickAndType(field: HTMLElement, text: string): void {
  focusField(field)
  typeInto(field, text)
}

/** ⌫ at the caret, `times` over. */
export function backspace(field: HTMLElement, times = 1): void {
  const { view } = editorOf(field)
  for (let i = 0; i < times; i += 1) {
    act(() => {
      const { from, to, empty } = view.state.selection
      if (empty && from <= 1) return
      view.dispatch(view.state.tr.delete(empty ? from - 1 : from, to))
    })
  }
}

/** Replaces everything in the field, as select-all and typing would. */
export function replaceField(field: HTMLElement, text: string): void {
  act(() => {
    editorOf(field).commands.clearContent(true)
  })
  clickAndType(field, text)
}
