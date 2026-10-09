import { useEffect, useMemo, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../lib/types'
import { formatBytes } from '../lib/format'
import { highlightCode } from '../lib/highlight'
import { FileCwdContext, FileMessageContext, MessageIdContext, fileOpenHandlers, messageImages } from '../lib/fileOpen'
import { rehypePathLinks } from '../lib/pathLinks'
import { rehypeSentTokens } from '../lib/sentTokens'
import { ImageThumb } from './ImageThumb'
import { PathButton, PlainPath } from './PathButton'
import { ReplyMedia } from './ReplyMedia'
import { parseSentSelection, stripSentOpenFile } from '../lib/ideSelection'
import { parseSentFiles } from '../lib/attachedFiles'
import { FileGlyph } from './AttachmentChip'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { copyToClipboard } from '../lib/clipboard'
import { RewindGlyph } from '../ui/UtilityButton'

/** 7a: two or more images share one wrapping row, each capped narrower. */
const TWO_UP_WIDTH_PX = 171

/**
 * The clock reading under a bubble — the house format, identical to the
 * model divider's (`TranscriptView.tsx`), `QuestionCard`'s answered-at line
 * and `FileViewer`'s footer. A fourth matching copy rather than a shared
 * helper, the same way `primaryTag` is a fifth: three lines with no
 * branching, and this repo has no formatting module they all already import.
 *
 * `ChatMessage.timestamp` is an ISO string, and it used to be interpolated
 * RAW — `2026-09-22T10:00:00.000Z`, all 24 characters, under every bubble.
 * That was invisible for most of its life, because only the reload path
 * (`entriesToMessages`) stamped a timestamp at all; task 1 of the subagent
 * branch started stamping the LIVE path too (for tool-row durations), which
 * widened it to every message in every transcript and cost a full extra
 * line per bubble in a 380 px panel
 * (fix: messageview-renders-a-raw-iso-timestamp).
 *
 * `undefined` for anything `Date` cannot parse, so a malformed stamp shows
 * nothing rather than the words "Invalid Date".
 */
function clockTime(timestamp: string): string | undefined {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return undefined
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

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
/** How long the copy button says "Copied" before it goes back to "Copy". */
const COPIED_FEEDBACK_MS = 1500

/**
 * The surface every plain (unhighlighted) fenced block shares. Long lines
 * wrap instead of scrolling sideways — a clipped line gave no hint that it
 * went on, since macOS hides the scrollbar — and `wrap-anywhere` breaks
 * unbroken tokens (URLs, hashes) too. No `overflow` here, on purpose: see
 * `CodeFrame`.
 */
const PLAIN_BLOCK =
  'rounded-md bg-black/30 p-3 font-mono text-xs text-text-soft whitespace-pre-wrap wrap-anywhere'

/**
 * A fenced block with a copy button in its top-right corner. The button stays
 * out of the way until the block is hovered or the button has focus, so a
 * transcript full of code does not turn into a column of buttons; it fades
 * with opacity, so hovering never reflows the text.
 *
 * The button is a right float at the head of the block, not an overlay:
 * lines wrap, so any line can reach the right edge, and an absolutely
 * positioned button would sit on top of it. A float only shortens the line
 * boxes beside it — the first line or two wrap around the button and the
 * rest of the block keeps its full width. That holds only while the `pre`
 * (and the `div` around shiki's `pre`) do NOT establish their own block
 * formatting context: an `overflow`, `flow-root` or `flex` on them turns the
 * float into a column beside a narrowed box. The frame itself is `flow-root`
 * so the float stays inside it even under a one-line block. The `pre` paints
 * the block's background (shiki sets its own inline) and floats paint above
 * block backgrounds, so the button sits on the block's own surface.
 */
function CodeFrame({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="group/code flow-root">
      <span className="float-right ml-2 mr-1.5 mt-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
        <Button
          variant="pill-muted"
          size="pill"
          aria-label="Copy code"
          onClick={() => void copyToClipboard(code).then((ok) => setCopied(ok))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </span>
      {children}
    </div>
  )
}

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
        // The fill and colour only show when shiki fell back to plain markup
        // (`plainCodeHtml`); a highlighted `pre` overrides both inline.
        className="text-xs [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-3 [&_pre]:text-text-soft [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"
        // Shiki output is trusted-safe HTML.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <pre className={PLAIN_BLOCK}>
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

/**
 * The text a `ReactNode` reads as. Only strings and numbers carry text, and
 * a node is often an array of them; anything else (an element, a fragment)
 * has no text of its own, and `String()` on it would yield `[object Object]`
 * — which would then be shown as if it were the code, or the link's label.
 */
function plainText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  return ''
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
    const code = plainText(codeProps.children).replace(/\n$/, '')

    return (
      <CodeFrame code={code}>
        {match ? (
          <CodeBlock code={code} lang={match[1]} />
        ) : (
          // Fenced, but no language on the fence — still a block, not inline.
          <pre className={PLAIN_BLOCK}>
            <code>{code}</code>
          </pre>
        )}
      </CodeFrame>
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
  'data-code'?: string
  'data-plain'?: string
}

/**
 * The `a` override for assistant prose. `rehypePathLinks` wraps detected
 * file paths in `<a data-path data-line>` elements; those render as
 * `PathButton`s, while every authored markdown link stays a plain anchor
 * (spec: 2026-09-19-file-viewer-design § Assistant prose).
 */
function MarkdownLink({ children, node: _node, ...rest }: AnchorProps & { node?: unknown }) {
  const path = rest['data-path']
  // A path no press can open, wrapped only for the phone's long-press
  // (`rehypePathLinks({ plain: true })`): text, never a link.
  if (path && rest['data-plain'] !== undefined) return <PlainPath path={path}>{children}</PlainPath>
  if (path) {
    const rawLine = rest['data-line']
    // The child text is the full hit area (`web/src/App.tsx:42:7`) — the
    // suffix past the path is display-only; only the line travels.
    const text = plainText(children)
    return (
      <PathButton
        path={path}
        line={rawLine !== undefined ? Number(rawLine) : null}
        variant={rest['data-code'] !== undefined ? 'code' : 'prose'}
        suffix={text.startsWith(path) ? text.slice(path.length) : undefined}
      />
    )
  }
  return <a {...rest}>{children}</a>
}

/** The machine-tag names, for stripping from the chip's line count only —
 * the expanded <pre> always shows the body verbatim, tags included. */
const COMMAND_TAG =
  /<\/?(local-command-caveat|local-command-stdout|local-command-stderr|system-reminder|command-message|command-name|command-args|command-contents|orbital-walkthrough(?:\s[^>]*)?)>/g

/** Chip line count (canvas 6d): body lines after tag stripping, trailing blanks dropped. */
export function commandLineCount(body: string): number {
  const lines = body.replace(COMMAND_TAG, '').split('\n')
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.length
}

/**
 * The ↶ chip beside a pickable turn in pick mode (canvas 27a/27c): 24px, 6px
 * radius, 8px left of the bubble and 4px below its top. Hung off the bubble
 * rather than laid out beside it, so entering pick mode moves nothing — the
 * bubble keeps its place and its width, and only this appears in the free
 * space the right-aligned turn always leaves on its left.
 */
function RewindMark({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      data-rewind-mark={active ? 'active' : 'target'}
      className={[
        'absolute top-[3px] grid h-6 w-6 place-items-center rounded-[6px] border transition-colors duration-150',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)] text-[rgba(200,220,245,.75)]',
      ].join(' ')}
      // The bubble's 1px border sits outside its padding box, which is what
      // `right: 100%` measures from: 8px of gap is 9px from there.
      style={{ right: 'calc(100% + 9px)' }}
    >
      <RewindGlyph />
    </span>
  )
}

export interface MessageViewProps {
  message: ChatMessage
  /**
   * Appends the export's blinking block caret after the text (canvas 1b's
   * streaming assistant turn). Only ever set for the last assistant message
   * of a session that is still working.
   */
  streaming?: boolean
  /**
   * Pick mode (canvas 27a/27c): a pickable user turn wears the neutral ↶ mark
   * beside its bubble, and the one previewed wears the accent ring and the
   * mark's active chip. Absent outside pick mode.
   */
  rewindMark?: 'target' | 'active'
}

/**
 * Renders a `user`, `assistant` or `thinking` `ChatMessage` as markdown (GFM tables,
 * fenced code blocks, etc). `tool_use`/`tool_result` messages are not
 * handled here — `Transcript` pairs those and renders them via `ToolRow`.
 */
export function MessageView({ message, streaming = false, rewindMark }: MessageViewProps) {
  const isUser = message.role === 'user'
  // The command-expansion fold (canvas 6c, spec:
  // 2026-09-18-transcript-folding-design). Only user turns carry `command`.
  const command = isUser ? message.command : undefined
  const [commandOpen, setCommandOpen] = useState(false)
  /**
   * The editor selection this turn carried, read back out of its own text
   * (spec 2026-09-23-ide-bridge-design; canvas `Feature - IDE bridge`
   * 20a/20b-5). The bubble shows what was TYPED and the range becomes a
   * caption under it — the block itself is what the model reads, not what the
   * person needs to re-read.
   *
   * Read back rather than stored because that is the only form that survives a
   * reload: the turn comes off the CLI's transcript as plain text.
   */
  const sentSelection = isUser ? parseSentSelection(message.text) : null
  const openFile = useOrbital((s) => s.openFile)
  const typedText = sentSelection ? sentSelection.text : (stripSentOpenFile(message.text) ?? message.text ?? '')
  // The files the turn carried ride as a list at the end of its text (spec
  // 2026-10-01-file-attachments-design § Transcript): read back here, shown as
  // receipts under the bubble.
  const sentFiles = isUser ? parseSentFiles(typedText) : null
  const bodyText = sentFiles ? sentFiles.text : typedText
  const files = sentFiles?.paths ?? []
  // Typed nothing → no empty bubble, the chip is the whole turn (6c B).
  const hasText = Boolean(bodyText.trim())
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
  const authored = hasText || hasImages || files.length > 0
  // The phone's seam (`lib/fileOpen.ts`): its presses say which message they
  // came from, so its viewer can page through this message's images, and a
  // path it cannot open is still wrapped, for the long-press. The desktop
  // configures nothing, provides nothing and matches as before.
  const routed = fileOpenHandlers()
  const fileMessage = useMemo(
    () => (routed ? { messageId: message.id, images: messageImages(message) } : null),
    [routed, message],
  )
  const plainPaths = Boolean(routed?.longPress)

  return (
    <FileMessageContext.Provider value={fileMessage}>
    {/* A path in this message opens from the tree it was written in. */}
    <FileCwdContext.Provider value={message.cwd}>
    <MessageIdContext.Provider value={message.id}>
    <div
      data-role={message.role}
      className={['flex flex-col gap-1', isUser && authored ? 'items-end' : 'items-start'].join(' ')}
    >
      {(hasText || (!command && !hasImages && files.length === 0)) && (
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
            ? 'max-w-[86%] rounded-[12px_12px_4px_12px] border bg-accent/12 px-3.5 py-2.5 text-[13px] leading-[1.5] text-text-bright'
            : 'max-w-[92%] text-[13px] leading-[1.55] text-[rgba(232,238,248,.92)]',
          // Canvas 27a: the previewed turn's ring — the border to accent .8
          // plus a 3px accent .14 glow, over .15s.
          isUser && rewindMark === 'active' ? 'border-accent/80 ring-[3px] ring-accent/14' : isUser ? 'border-accent/30' : '',
          isUser && rewindMark ? 'relative transition-[border-color,box-shadow] duration-150' : '',
        ].join(' ')}
      >
        {isUser && rewindMark && <RewindMark active={rewindMark === 'active'} />}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // Path detection runs over ASSISTANT prose only — a user turn is
          // quoted speech, not the agent narrating file work (spec § prose).
          // The user turn gets the composer's tints instead, holding after the
          // turn went out (canvas 9e SENT). The two never share a turn: one
          // makes paths pressable, the other says "this was parsed".
          rehypePlugins={
            isUser ? [rehypeSentTokens] : plainPaths ? [[rehypePathLinks, { plain: true }]] : [rehypePathLinks]
          }
          components={isUser ? { code: Code, pre: Pre } : { code: Code, pre: Pre, a: MarkdownLink }}
        >
          {bodyText}
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
      {/* 24f A: the images and PDFs the reply names, under its text. */}
      {!isUser && <ReplyMedia message={message} />}
      {sentSelection && (
        // 20a / 20f: a 9.5px caption 6px under the bubble — the lines glyph,
        // the count, and the file as a pressable path to the lines. It is a
        // receipt, not a control: there is nothing here to undo.
        <button
          type="button"
          data-sent-selection
          onClick={() => openFile(sentSelection.path, sentSelection.lineStart)}
          className="mt-[2px] flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.04em] text-[rgba(160,190,225,.55)]"
        >
          {/* The lip's three bars, at the caption's smaller scale (20a). */}
          <span aria-hidden className="relative block h-[7px] w-2 flex-none">
            <span className="absolute left-0 top-0 block h-[1.3px] w-2 bg-[rgba(160,190,225,.5)]" />
            <span className="absolute left-0 top-[2.9px] block h-[1.3px] w-[5.5px] bg-[rgba(160,190,225,.5)]" />
            <span className="absolute left-0 top-[5.8px] block h-[1.3px] w-[7px] bg-[rgba(160,190,225,.5)]" />
          </span>
          {sentSelection.lineCount} line{sentSelection.lineCount === 1 ? '' : 's'} from{' '}
          <span className="border-b border-dashed border-[rgba(150,205,255,.3)] text-[#cfe6ff]">
            {sentSelection.path.slice(sentSelection.path.lastIndexOf('/') + 1)}
            <span className="text-accent">
              :{sentSelection.lineStart}
              {sentSelection.lineEnd > sentSelection.lineStart ? `–${sentSelection.lineEnd}` : ''}
            </span>
          </span>
        </button>
      )}
      {files.length > 0 && (
        <div data-sent-files className="flex max-w-[86%] flex-wrap justify-end gap-1.5">
          {files.map((path, i) => {
            const name = path.slice(path.lastIndexOf('/') + 1)
            return (
              <span
                key={`${i}:${path}`}
                title={path}
                className="flex min-w-0 items-center gap-1.5 rounded-[6px] border border-[rgba(150,205,255,.16)] bg-[rgba(150,205,255,.05)] py-1 pl-1 pr-2"
              >
                <FileGlyph name={name} small />
                <span className="truncate font-mono text-[10.5px] text-text-bright">{name}</span>
              </span>
            )
          })}
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
                messageId={message.id}
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
      {message.timestamp && clockTime(message.timestamp) && (
        <span className="font-mono text-[10px] text-text-muted">
          {clockTime(message.timestamp)}
        </span>
      )}
    </div>
    </MessageIdContext.Provider>
    </FileCwdContext.Provider>
    </FileMessageContext.Provider>
  )
}
