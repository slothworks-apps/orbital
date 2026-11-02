import { describe, it, expect, afterEach } from 'vitest'
import { textMenuEntries, textMenuTarget } from '../ui/TextContextMenu'
import type { MenuItem } from '../ui/Menu'

afterEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

function enabled(target: NonNullable<ReturnType<typeof textMenuTarget>>): string[] {
  return textMenuEntries(target, () => {})
    .filter((e): e is MenuItem => typeof e === 'object' && 'onSelect' in e && !e.disabled)
    .map((e) => e.key)
}

describe('textMenuTarget — fields', () => {
  it('takes a text input, and only Paste and Select All act on it with nothing selected', () => {
    const input = mount('<input type="text" value="hello">') as HTMLInputElement
    const target = textMenuTarget(input, 0, 0, document.getSelection())
    expect(target).toMatchObject({ kind: 'field', field: input, selected: false, writable: true })
    expect(enabled(target!)).toEqual(['paste', 'select-all'])
  })

  it('enables Cut and Copy once the field has a selection', () => {
    const input = mount('<textarea>hello world</textarea>') as HTMLTextAreaElement
    input.setSelectionRange(0, 5)
    expect(enabled(textMenuTarget(input, 0, 0, document.getSelection())!)).toEqual(['cut', 'copy', 'paste', 'select-all'])
  })

  it('lets a read-only field be copied from but not cut or pasted into', () => {
    const input = mount('<input readonly value="hello">') as HTMLInputElement
    input.setSelectionRange(0, 5)
    expect(enabled(textMenuTarget(input, 0, 0, document.getSelection())!)).toEqual(['copy', 'select-all'])
  })

  it('never copies or cuts out of a password field', () => {
    const input = mount('<input type="password" value="secret">') as HTMLInputElement
    input.setSelectionRange(0, 6)
    expect(enabled(textMenuTarget(input, 0, 0, document.getSelection())!)).toEqual(['paste', 'select-all'])
  })

  it('leaves inputs that hold no typed text alone', () => {
    for (const type of ['checkbox', 'range', 'button']) {
      const input = mount(`<input type="${type}">`)
      expect(textMenuTarget(input, 0, 0, document.getSelection())).toBeNull()
    }
  })

  it('takes a click on a node inside an editable region as the region', () => {
    const editor = mount('<div contenteditable="true"><p><span>text</span></p></div>')
    const span = editor.querySelector('span')!
    expect(textMenuTarget(span, 0, 0, document.getSelection())).toMatchObject({ kind: 'field', field: editor })
  })
})

describe('textMenuTarget — selected text', () => {
  it('opens nothing on selectable text with no selection', () => {
    const p = mount('<p data-selectable>Two failures</p>')
    expect(textMenuTarget(p, 0, 0, document.getSelection())).toBeNull()
  })

  it('opens nothing for a selection outside a selectable surface', () => {
    const p = mount('<p>chrome label</p>')
    document.getSelection()!.selectAllChildren(p)
    expect(textMenuTarget(p, 0, 0, document.getSelection())).toBeNull()
  })

  it('opens nothing for a non-element target', () => {
    expect(textMenuTarget(null, 0, 0, document.getSelection())).toBeNull()
  })
})
