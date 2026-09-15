import { useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../lib/types'
import { highlightCode } from '../lib/highlight'

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
        // eslint-disable-next-line react/no-danger -- shiki output is trusted-safe HTML
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
function Code({ children, ...rest }: CodeProps) {
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
function Pre({ children, className, ...rest }: PreProps) {
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

export interface MessageViewProps {
  message: ChatMessage
}

/**
 * Renders a `user` or `assistant` `ChatMessage` as markdown (GFM tables,
 * fenced code blocks, etc). `tool_use`/`tool_result` messages are not
 * handled here — `Transcript` pairs those and renders them via `ToolRow`.
 */
export function MessageView({ message }: MessageViewProps) {
  const isUser = message.role === 'user'

  return (
    <div
      data-role={message.role}
      className={['flex flex-col gap-1', isUser ? 'items-end' : 'items-start'].join(' ')}
    >
      <div
        className={[
          'message-markdown max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed',
          '[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
          '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
          '[&_th]:border [&_th]:border-panel-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
          '[&_td]:border [&_td]:border-panel-border [&_td]:px-2 [&_td]:py-1',
          '[&_a]:underline [&_a]:decoration-dotted',
          isUser ? 'bg-white/10 text-text-bright' : 'bg-transparent text-text-soft',
        ].join(' ')}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: Code, pre: Pre }}>
          {message.text ?? ''}
        </ReactMarkdown>
      </div>
      {message.timestamp && (
        <span className="font-mono text-[10px] text-text-muted">{message.timestamp}</span>
      )}
    </div>
  )
}
