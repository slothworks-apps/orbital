import { useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../lib/types'
import { formatBytes } from '../lib/format'
import { highlightCode } from '../lib/highlight'
import { rehypePathLinks } from '../lib/pathLinks'
import { rehypeSentTokens } from '../lib/sentTokens'
import { ImageThumb } from './ImageThumb'
import { PathButton } from './PathButton'

/** 7a: two or more images share one wrapping row, each capped narrower. */
const TWO_UP_WIDTH_PX = 171

/** Matches remark/rehype's `language-xxx` class, which is only ever applied
 * to fenced code blocks (never to inline `code`) — the standard way to tell
 * the two apart from inside a react-markdown `code` component override. */
const LANGUAGE_CLASS = /language-(\S+)/

/**
 * A fenced code block. Renders plain escaped text synchronously (accessible,
 * screen-reader-friendly, never blocks first paint) and swaps in shiki's
 * highlighted markup once `highlightCode` resolves. shiki's output is
 * trusted-safe HTML, so `dangerouslySetInnerHTML` here never carries
 * unescaped user input directly.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    void highlightCode(code, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  if (html !== null) {
    return (
      <div
        className="overflow-x-auto rounded-md text-xs [&_pre]:p-3"
        // Shiki output is trusted-safe HTML.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <pre className="overflow-x-auto rounded-md bg-black/30 p-3 font-mono text-xs text-text-soft">
      <code>{code}</code>
    </pre>
  )
}

type CodeProps = ComponentPropsWithoutRef<'code'> & { className?: string }

/**
 * INLINE code only. Fenced code blocks — even ones with no language, e.g.
 * a plain ``` ``` block — are always wrapped by remark/rehype in a `<pre>`
 * parent, and that parent is fully handled by the `Pre` override below
 * (which reads this element's raw props before it ever gets rendered). This
 * component is only reached for standalone `code` nodes that have no `pre`
 * parent, i.e. genuinely inline code.
 */
export function Code({ children, ...rest }: CodeProps) {
  return (
    <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
      {children}
    </code>
  )
}

type PreProps = ComponentPropsWithoutRef<'pre'>

/**
 * Fenced code blocks always render as `<pre><code>…</code></pre>` — with a
 * `language-xxx` class on the `code` element only when a language was
 * specified on the fence. Overriding `pre` (rather than only `code`) is
 * what lets a language-less fenced block still get block-level treatment:
 * react-markdown builds `codeEl` (a `<Code className=… children=…>`
 * element) as a leaf *before* calling this component, so its `.props` here
 * are still the pristine, unrendered language-class + text — reading them
 * doesn't invoke `Code` at all, so its inline styling is never applied to
 * a fenced block, with or without a language.
 */
export function Pre({ children, className, ...rest }: PreProps) {
  const codeEl = Array.isArray(children) ? children[0] : children
  if (codeEl && typeof codeEl === 'object' && 'props' in codeEl) {
    const codeProps = (codeEl as { props: { className?: string; children?: ReactNode } }).props
    const match = LANGUAGE_CLASS.exec(codeProps.className ?? '')
    const code = String(codeProps.children ?? '').replace(/\n$/, '')

    if (match) {
      return <CodeBlock code={code} lang={match[1]} />
    }
    // Fenced, but no language on the fence — still a block, not inline.
    return (
      <pre className="overflow-x-auto rounded-md bg-black/30 p-3 font-mono text-xs text-text-soft">
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <pre className={className} {...rest}>
      {children}
    </pre>
  )
}

type AnchorProps = ComponentPropsWithoutRef<'a'> & {
  'data-path'?: string
  'data-line'?: string
}

/**
 * The `a` override for assistant prose. `rehypePathLinks` wraps detected
 * file paths in `<a data-path data-line>` elements; those render as
 * `PathButton`s, while every authored markdown link stays a plain anchor
 * (spec: 2026-09-19-file-viewer-design § Assistant prose).
 */
function MarkdownLink({ children, node: _node, ...rest }: AnchorProps & { node?: unknown }) {
  const path = rest['data-path']
  if (path) {
    const rawLine = rest['data-line']
    // The child text is the full hit area (`web/src/App.tsx:42:7`) — the
    // suffix past the path is display-only; only the line travels.
    const text = Array.isArray(children) ? children.join('') : String(children ?? '')
    return (
      <PathButton
        path={path}
        line={rawLine !== undefined ? Number(rawLine) : null}
        variant="prose"
        suffix={text.startsWith(path) ? text.slice(path.length) : undefined}
      />
    )
  }
  return <a {...rest}>{children}</a>
}

/** The machine-tag names, for stripping from the chip's line count only —
 * the expanded <pre> always shows the body verbatim, tags included. */
const COMMAND_TAG =
  /<\/?(local-command-caveat|local-command-stdout|local-command-stderr|system-reminder|command-message|command-name|command-args|command-contents)>/g

/** Chip line count (canvas 6d): body lines after tag stripping, trailing blanks dropped. */
export function commandLineCount(body: string): number {
  const lines = body.replace(COMMAND_TAG, '').split('\n')
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.length
}

export interface MessageViewProps {
  message: ChatMessage
  /**
   * Appends the export's blinking block caret after the text (canvas 1b's
   * streaming assistant turn). Only ever set for the last assistant message
   * of a session that is still working.
   */
  streaming?: boolean
}

/**
 * Renders a `user` or `assistant` `ChatMessage` as markdown (GFM tables,
 * fenced code blocks, etc). `tool_use`/`tool_result` messages are not
 * handled here — `Transcript` pairs those and renders them via `ToolRow`.
 */
export function MessageView({ message, streaming = false }: MessageViewProps) {
  const isUser = message.role === 'user'
  // The command-expansion fold (canvas 6c, spec:
  // 2026-09-18-transcript-folding-design). Only user turns carry `command`.
  const command = isUser ? message.command : undefined
  const [commandOpen, setCommandOpen] = useState(false)
  // Typed nothing → no empty bubble, the chip is the whole turn (6c B).
  const hasText = Boolean(message.text?.trim())
  // Transcript images (canvas 7a): an image-only turn renders the
  // thumbnail AS the bubble — no empty markdown bubble above it.
  const images = message.images ?? []
  const hasImages = images.length > 0
  /**
   * Whether a person put anything in this turn. A user-role turn carrying
   * nothing but machine context was written by the CLI, not by them — a
   * resumed session's task notifications (spec
   * 2026-09-21-session-autoheal-design), a slash command's expansion with no
   * prose around it — so it sits on the agent's side of the column. Right
   * alignment is the transcript's way of saying "you said this", and it must
   * not be lent to words the user never wrote.
   *
   * A turn that has both keeps its right alignment: the human did speak, and
   * the chip trails what they said.
   */
  const authored = hasText || hasImages

  return (
    <div
      data-role={message.role}
      className={['flex flex-col gap-1', isUser && authored ? 'items-end' : 'items-start'].join(' ')}
    >
      {(hasText || (!command && !hasImages)) && (
      <div
        className={[
          'message-markdown [text-wrap:pretty]',
          // The caret has to sit on the same line as the text it trails, so
          // the closing paragraph goes inline while it is showing (1b).
          streaming ? '[&>p:last-child]:inline' : '',
          '[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
          '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
          '[&_th]:border [&_th]:border-panel-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
          '[&_td]:border [&_td]:border-panel-border [&_td]:px-2 [&_td]:py-1',
          '[&_a]:underline [&_a]:decoration-dotted',
          // Canvas 1b: the user's turn is an accent-tinted bubble with a
          // notched bottom-right corner (radius 12/12/4/12), 10px×14px
          // padding, capped at 86% of the column; the assistant's turn has
          // no bubble at all — plain 13px/1.55 text, up to 92% wide.
          isUser
            ? 'max-w-[86%] rounded-[12px_12px_4px_12px] border border-accent/30 bg-accent/12 px-3.5 py-2.5 text-[13px] leading-[1.5] text-text-bright'
            : 'max-w-[92%] text-[13px] leading-[1.55] text-[rgba(232,238,248,.92)]',
        ].join(' ')}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // Path detection runs over ASSISTANT prose only — a user turn is
          // quoted speech, not the agent narrating file work (spec § prose).
          // The user turn gets the composer's tints instead, holding after the
          // turn went out (canvas 9e SENT). The two never share a turn: one
          // makes paths pressable, the other says "this was parsed".
          rehypePlugins={isUser ? [rehypeSentTokens] : [rehypePathLinks]}
          components={isUser ? { code: Code, pre: Pre } : { code: Code, pre: Pre, a: MarkdownLink }}
        >
          {message.text ?? ''}
        </ReactMarkdown>
        {streaming && (
          // 1b: 7×14px accent block, 3px after the last glyph.
          <span
            aria-hidden
            data-streaming-caret
            className="orbital-pulse ml-[3px] inline-block h-3.5 w-[7px] translate-y-[2px] bg-accent"
          />
        )}
      </div>
      )}
      {hasImages && (
        // 7a: one wrapping row, 6px gap; under a bubble the image sits at
        // the column's own gap, aligned to the bubble's right edge.
        <div className={['flex flex-wrap gap-1.5', isUser ? 'justify-end' : 'justify-start'].join(' ')}>
          {images.map((image) => {
            // Local-only, so it exists on the optimistic turn and on the WS
            // replacement that supersedes it — and on nothing that came back
            // from a reload (spec § The transcript side). ImageThumb's geometry
            // is untouched; only the caption line below is new.
            const provenance = message.imageProvenance?.[image.ref]
            const thumb = (
              <ImageThumb
                image={image}
                variant={isUser && !hasText && !command ? 'user-solo' : 'user'}
                source={provenance?.name ?? 'pasted image'}
                widthCapPx={images.length > 1 ? TWO_UP_WIDTH_PX : undefined}
              />
            )
            if (!provenance) return <div key={image.ref}>{thumb}</div>
            return (
              // 9c-3: caption 4px under the thumb, aligned with its own edge.
              <div
                key={image.ref}
                className={[
                  'flex flex-col gap-1',
                  isUser ? 'items-end' : 'items-start',
                ].join(' ')}
              >
                {thumb}
                <span
                  data-image-caption
                  className="font-mono text-[9px] tracking-[0.06em] text-[rgba(160,190,225,.5)]"
                >
                  {provenance.name} · {formatBytes(image.bytes)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {command && (
        <>
          {/* The expansion chip (canvas 6c): resting chip convention —
              1px border, no fill, 5/10px padding — under the bubble at a 6px
              gap (the column's 4px gap + 2px). It follows the column's
              alignment, so it trails a typed turn on the right and stands on
              the left when the machine context IS the whole turn (`authored`). */}
          <button
            type="button"
            aria-expanded={commandOpen}
            onClick={() => setCommandOpen((v) => !v)}
            className={[
              'mt-[2px] flex items-center gap-[7px] rounded-[7px] border px-2.5 py-[5px] font-mono text-[11.5px]',
              commandOpen
                ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
                : 'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.8)] hover:border-[rgba(150,205,255,.26)] hover:bg-[rgba(150,205,255,.07)]',
            ].join(' ')}
          >
            <span
              aria-hidden
              className={[
                'w-2 text-[9px] text-[rgba(160,190,225,.6)] transition-transform duration-[160ms] ease-out',
                commandOpen ? 'rotate-90' : '',
              ].join(' ')}
            >
              ▸
            </span>
            {command.name ? (
              <span className="text-text-bright">{command.name}</span>
            ) : (
              // Nothing here was authored — muted row ink, never #e8eef8 (6c D).
              <span>machine context{command.blocks > 1 ? ` ×${command.blocks}` : ''}</span>
            )}
            <span className="text-[rgba(160,190,225,.5)]">· {commandLineCount(command.body)} lines</span>
          </button>
          {commandOpen && (
            // Verbatim, never markdown; left-aligned even in a right-aligned
            // turn — it's a file, not speech (6c C).
            <pre className="mt-[2px] max-h-[168px] w-full self-stretch overflow-auto whitespace-pre-wrap rounded-[7px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] px-3 py-2.5 text-left font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
              {command.body}
            </pre>
          )}
        </>
      )}
      {message.timestamp && (
        <span className="font-mono text-[10px] text-text-muted">{message.timestamp}</span>
      )}
    </div>
  )
}
