import { noticeDots } from '../lib/noticeQueue'

/**
 * The passive dots above a notice toast (canvas `Feature - Notice toast` 1c
 * DOTS): how many messages are queued, the one showing filled. Nothing for a
 * single message. `map` is the desktop's size (1a: 6 px dots, 8 px apart),
 * `touch` the phone's (2a: 7 px, 9 px apart).
 */
export function NoticeDots({ count, size }: { count: number; size: 'map' | 'touch' }) {
  const { dots, more } = noticeDots(count)
  if (dots.length === 0) return null
  const dot = size === 'map' ? 'h-1.5 w-1.5' : 'h-[7px] w-[7px]'
  return (
    <div
      aria-label={`${count} messages`}
      className={['flex h-3.5 items-center justify-center', size === 'map' ? 'gap-2' : 'gap-[9px]'].join(' ')}
    >
      {dots.map((state, i) => (
        <span
          key={i}
          aria-hidden
          className={[
            'block rounded-full',
            dot,
            state === 'current' ? 'bg-text-bright' : 'border border-[rgba(160,190,225,.6)]',
          ].join(' ')}
        />
      ))}
      {more > 0 && (
        <span aria-hidden className="ml-0.5 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.6)]">
          +{more}
        </span>
      )}
    </div>
  )
}
