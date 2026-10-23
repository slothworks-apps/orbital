import { Children, isValidElement, memo, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LANGUAGE_CLASS, plainText } from '../../panels/MessageView'
import type { MarkdownLink } from './markdownLinks'
import { markdownLink } from './markdownLinks'
import { useTokens } from '../../lib/useTokens'

/** react-markdown's guard reads `notes.md:42` as an unknown scheme and empties it; a path with a line is let through. */
function urlTransform(url: string): string {
  return defaultUrlTransform(url) || (/^[^:/?#]+:\d+(?::\d+)?$/.test(url) ? url : '')
}

/** The source line a rendered block starts on, so a switch to Source keeps the reader's place. */
function at(node: ExtraProps['node']): { 'data-src-line'?: number } {
  const line = node?.position?.start.line
  return line ? { 'data-src-line': line } : {}
}

// 10d·e "Rendered — sized for 390": the link is 10d's path style, its 12px
// pad and negative margin making a 44px hit area without moving the line.
const LINK = 'my-[-12px] py-3 text-[oklch(85%_0.12_205)] underline decoration-dotted underline-offset-[3px]'
const INLINE_CODE = 'rounded-[4px] bg-[rgba(150,205,255,.08)] px-[5px] py-px font-mono text-[12.5px] text-[#dfeeff]'
const BOX = 'grid h-4 w-4 flex-none place-items-center rounded-[4px] border mt-1 text-[10px] leading-none'

/** A fenced block: mono 12/1.7 in its own box that scrolls sideways, no line numbers (as 8b). */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const lines = code.split('\n')
  const tokens = useTokens(code, lang, lines.length)
  return (
    <div className="overflow-x-auto rounded-[9px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)]">
      <div className="w-max px-3.5 py-[11px] font-mono text-[12px] leading-[1.7] whitespace-pre text-[rgba(214,230,248,.9)] [font-variant-ligatures:none] [overflow-wrap:normal]">
        {lines.map((line, i) => (
          // A static list of lines: the index is a stable key.
          <div key={i}>
            {tokens
              ? tokens[i].map((token, j) => (
                  <span key={j} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))
              : line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function components(onLink: (link: MarkdownLink) => void, path: string): Components {
  const press = (href: string | undefined) => (event: { preventDefault: () => void }) => {
    event.preventDefault()
    onLink(markdownLink(href, path))
  }
  return {
    h1: ({ node, children }) => (
      <h1 {...at(node)} className="m-0 text-[22px] font-bold leading-[1.25] tracking-[-.015em] text-[#e8eef8] [text-wrap:balance]">
        {children}
      </h1>
    ),
    h2: ({ node, children }) => (
      <h2 {...at(node)} className="m-0 mt-1.5 text-[17px] font-bold leading-[1.3] tracking-[-.01em] text-[#e8eef8]">
        {children}
      </h2>
    ),
    ...Object.fromEntries(
      (['h3', 'h4', 'h5', 'h6'] as const).map((Tag) => [
        Tag,
        ({ node, children }: ComponentPropsWithoutRef<'h3'> & ExtraProps) => (
          <Tag {...at(node)} className="m-0 mt-1 text-[15px] font-bold leading-[1.35] text-[#e8eef8]">
            {children}
          </Tag>
        ),
      ]),
    ),
    p: ({ node, children }) => (
      <p {...at(node)} className="m-0 [text-wrap:pretty]">
        {children}
      </p>
    ),
    a: ({ href, children }) => (
      <a href={href} onClick={press(href)} className={LINK}>
        {children}
      </a>
    ),
    // 10d·e: an image is a tappable path that opens the 10d viewer, never drawn inline.
    img: ({ src, alt }) => {
      const href = typeof src === 'string' ? src : undefined
      return (
        <a href={href} onClick={press(href)} className={`${LINK} font-mono text-[12.5px]`}>
          {alt || href}
        </a>
      )
    },
    code: ({ children }) => <code className={INLINE_CODE}>{children}</code>,
    pre: ({ node, children }) => {
      const codeEl = Children.toArray(children)[0]
      const props = isValidElement<{ className?: string; children?: ReactNode }>(codeEl) ? codeEl.props : {}
      const lang = LANGUAGE_CLASS.exec(props.className ?? '')?.[1] ?? ''
      return (
        <div {...at(node)}>
          <CodeBlock code={plainText(props.children).replace(/\n$/, '')} lang={lang} />
        </div>
      )
    },
    ul: ({ node, className, children }) => (
      <ul
        {...at(node)}
        className={[
          'm-0 flex flex-col gap-1.5 [li_&]:mt-1.5 [li_&]:gap-1',
          className?.includes('contains-task-list') ? 'list-none pl-0' : 'list-disc pl-5 [li_&]:pl-[18px]',
        ].join(' ')}
      >
        {children}
      </ul>
    ),
    ol: ({ node, children, start }) => (
      <ol {...at(node)} start={start} className="m-0 flex list-decimal flex-col gap-1.5 pl-[22px] [li_&]:mt-1.5">
        {children}
      </ol>
    ),
    li: ({ node, className, children }) => {
      if (!className?.includes('task-list-item')) return <li {...at(node)}>{children}</li>
      // The box is its own flex item; the rest stays one inline run, so a code span does not split it.
      const [box, ...rest] = Children.toArray(children)
      return (
        <li {...at(node)} className="flex gap-2.5">
          {box}
          <span className="min-w-0 [text-wrap:pretty]">{rest}</span>
        </li>
      )
    },
    // Task boxes are read-only and never toggle (10d·e); ✓ wears the active chip.
    input: ({ checked }) =>
      checked ? (
        <span aria-label="done" className={`${BOX} border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]`}>
          ✓
        </span>
      ) : (
        <span aria-label="open" className={`${BOX} border-[rgba(160,190,225,.45)]`} />
      ),
    blockquote: ({ node, children }) => (
      <blockquote
        {...at(node)}
        className="m-0 flex flex-col gap-2 rounded-r-lg border-l-2 border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.04)] px-3.5 py-2.5 text-[14.5px] leading-[1.6] text-[rgba(200,214,235,.85)]"
      >
        {children}
      </blockquote>
    ),
    // A table wider than the page scrolls inside its frame; the page itself never moves sideways.
    table: ({ node, children }) => (
      <div {...at(node)} className="overflow-x-auto rounded-[9px] border border-[rgba(150,205,255,.12)]">
        <table className="w-full min-w-[300px] border-collapse text-[13.5px] leading-[1.4] [overflow-wrap:normal] [&_tr:last-child>td]:border-b-0">
          {children}
        </table>
      </div>
    ),
    th: ({ children, style }) => (
      <th
        style={style}
        className="border-b border-[rgba(150,205,255,.12)] bg-[rgba(150,205,255,.04)] px-3 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-[.14em] text-[rgba(160,190,225,.6)]"
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border-b border-[rgba(150,205,255,.08)] px-3 py-2">
        {children}
      </td>
    ),
    hr: ({ node }) => <hr {...at(node)} className="my-1 h-px border-0 bg-[rgba(150,205,255,.12)]" />,
  }
}

/**
 * A markdown file as a document (canvas `Feature - Phone text preview` 10d·b,
 * 10d·e "Rendered — sized for 390"): the transcript's pipeline at phone
 * reading size. Every block carries the source line it starts on.
 */
export const PhoneMarkdown = memo(function PhoneMarkdown({
  content,
  path,
  onLink,
}: {
  content: string
  /** The file's path, which its relative links are read against. */
  path: string
  onLink: (link: MarkdownLink) => void
}) {
  // Stable component types: a fresh set would remount the whole document on every render.
  const parts = useMemo(() => components(onLink, path), [onLink, path])
  return (
    <div className="flex flex-col gap-3.5 px-5 pb-8 pt-[18px] text-[15px] leading-[1.6] text-[rgba(228,238,250,.9)] [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={parts}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
