import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageView } from '../panels/MessageView'
import { rehypeSentTokens, type HastRoot } from '../lib/sentTokens'
import type { ChatMessage, ImageRefEntry } from '../lib/types'

/**
 * The sent turn (spec: 2026-09-20-composer-design § The transcript side; canvas
 * 9c-3 and 9e SENT): the composer's tints hold after the turn goes out, and a
 * thumbnail gains a caption for as long as this client remembers where the
 * image came from.
 */

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'user', ...overrides }
}

const IMG: ImageRefEntry = { ref: `${'a'.repeat(64)}.png`, w: 1512, h: 982, bytes: 290_816 }
const IMG_B: ImageRefEntry = { ref: `${'b'.repeat(64)}.png`, w: 1170, h: 760, bytes: 200_704 }

const token = (kind: 'command' | 'mention') =>
  document.querySelectorAll(`[data-token="${kind}"]`)

// ---------------------------------------------------------------------------
// The plugin, on its own
// ---------------------------------------------------------------------------

/** One paragraph of plain text, the shape rehype hands the plugin. */
function paragraph(...values: string[]): HastRoot {
  return {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: values.map((value) => ({ type: 'text' as const, value })),
      },
    ],
  }
}

/** Flattens a walked tree back to `[tagName|null, text]` pairs. */
function flatten(node: { children: unknown[] }): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = []
  const visit = (children: unknown[], tag: string | null) => {
    for (const child of children as Array<Record<string, never>>) {
      const c = child as unknown as {
        type: string
        value?: string
        tagName?: string
        properties?: { className?: string }
        children?: unknown[]
      }
      if (c.type === 'text') out.push([tag, c.value ?? ''])
      else if (c.children) visit(c.children, c.properties?.className ?? c.tagName ?? null)
    }
  }
  visit(node.children, null)
  return out
}

describe('rehypeSentTokens', () => {
  it('tints a position-0 command and leaves the rest of the sentence alone', () => {
    const tree = paragraph('/code-review the staged diff')
    rehypeSentTokens()(tree)
    expect(flatten(tree)).toEqual([
      ['orbital-sent-command', '/code-review'],
      ['p', ' the staged diff'],
    ])
  })

  it('never tints a slug that is not at position 0', () => {
    const tree = paragraph('run /code-review on it')
    rehypeSentTokens()(tree)
    expect(flatten(tree)).toEqual([['p', 'run /code-review on it']])
  })

  it('tints a mention anywhere, keeping the `:line` in its own muted span', () => {
    const tree = paragraph('look at @web/src/App.tsx:42 please')
    rehypeSentTokens()(tree)
    expect(flatten(tree)).toEqual([
      ['p', 'look at '],
      ['orbital-sent-mention', '@web/src/App.tsx'],
      ['orbital-sent-suffix', ':42'],
      ['p', ' please'],
    ])
  })

  it('re-joins to the input verbatim — a display tint may never move a glyph', () => {
    const source = '/commit then check @a/b.ts:7:2 and @c/d.ts.'
    const tree = paragraph(source)
    rehypeSentTokens()(tree)
    expect(flatten(tree).map(([, text]) => text).join('')).toBe(source)
  })

  it('treats only the FIRST text node as position 0', () => {
    const tree = paragraph('hello ', '/commit')
    rehypeSentTokens()(tree)
    expect(token('command')).toHaveLength(0)
    expect(flatten(tree)).toEqual([
      ['p', 'hello '],
      ['p', '/commit'],
    ])
  })

  it('leaves code and links untouched — quoted material is not parsed', () => {
    const tree: HastRoot = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: '@web/src/App.tsx' }],
            },
          ],
        },
      ],
    }
    rehypeSentTokens()(tree)
    expect(flatten(tree)).toEqual([['code', '@web/src/App.tsx']])
  })
})

// ---------------------------------------------------------------------------
// In the transcript
// ---------------------------------------------------------------------------

describe('MessageView — the sent tint holds (canvas 9e SENT)', () => {
  it('tints a user turn`s command and mentions, display-only', () => {
    render(
      <MessageView
        message={makeMessage({ id: '1', text: '/code-review against @bench/p95.json please' })}
      />
    )
    expect(token('command')[0]).toHaveTextContent('/code-review')
    expect(token('mention')[0]).toHaveTextContent('@bench/p95.json')
    // Not pressable: the tint says "parsed", never "press" (9a).
    expect(token('command')[0].tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: /code-review/ })).toBeNull()
  })

  it('tints ANY position-0 slug — there is no catalog to check history against', () => {
    render(<MessageView message={makeMessage({ id: '1', text: '/a-command-nobody-has now' })} />)
    expect(token('command')[0]).toHaveTextContent('/a-command-nobody-has')
  })

  it('leaves an assistant turn to the path links it already had', () => {
    render(
      <MessageView
        message={makeMessage({ id: '1', role: 'assistant', text: 'see web/src/App.tsx:4' })}
      />
    )
    expect(token('command')).toHaveLength(0)
    expect(token('mention')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /App\.tsx/ })).toBeInTheDocument()
  })
})

describe('MessageView — thumbnail captions (canvas 9c-3)', () => {
  it('captions a thumbnail when this client knows where the image came from', () => {
    render(
      <MessageView
        message={makeMessage({
          id: '1',
          text: 'both at 390',
          images: [IMG, IMG_B],
          imageProvenance: {
            [IMG.ref]: { name: 'Clipboard image', source: 'clipboard' },
            [IMG_B.ref]: { name: 'after-390.png', source: 'file' },
          },
        })}
      />
    )
    const captions = document.querySelectorAll('[data-image-caption]')
    expect(captions).toHaveLength(2)
    expect(captions[0]).toHaveTextContent('Clipboard image · 284 KB')
    expect(captions[1]).toHaveTextContent('after-390.png · 196 KB')
  })

  it('renders a history turn captionless, exactly as before — an SDK block has no name', () => {
    render(<MessageView message={makeMessage({ id: '1', text: 'look', images: [IMG] })} />)
    expect(document.querySelectorAll('[data-image-caption]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Open image full size' })).toBeInTheDocument()
  })

  it('captions only the images it has provenance for', () => {
    render(
      <MessageView
        message={makeMessage({
          id: '1',
          images: [IMG, IMG_B],
          imageProvenance: { [IMG.ref]: { name: 'Clipboard image', source: 'clipboard' } },
        })}
      />
    )
    expect(document.querySelectorAll('[data-image-caption]')).toHaveLength(1)
  })
})
