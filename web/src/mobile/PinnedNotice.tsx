import type { ReactNode } from 'react'
import { NOTICE_FADE_TRANSITION } from '../ui/motion'
import { NoticeDots } from '../ui/NoticeDots'
import { useNoticeSwap } from '../ui/useNoticeSwap'
import { usePhoneNotices } from './notices'

/**
 * The phone's notice toast (canvas `Feature - Notice toast` 2a–2d): pinned
 * above the session list, not scrolling with it, one message at a time with
 * the dots for the rest above it. When the last one goes, the list moves up
 * into its place. The desktop's counterpart is `ui/MapNoticeHost`.
 */
export function PinnedNoticeHost() {
  const head = usePhoneNotices((s) => s.queue[0] ?? null)
  const count = usePhoneNotices((s) => s.queue.length)
  const dismiss = usePhoneNotices((s) => s.dismiss)
  const { shown, visible } = useNoticeSwap(head)

  if (!shown) return null
  const { Body, id } = shown
  return (
    // 2a: 2/12/8 margin, the dots 8 px above the card.
    <div
      inert={!visible}
      className={[
        'mx-3 mb-2 mt-0.5 flex flex-col items-center gap-2',
        NOTICE_FADE_TRANSITION,
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
    >
      <NoticeDots count={count} size="touch" />
      <Body key={id} close={() => dismiss(id)} />
    </div>
  )
}

/** The card (2a): a mono label, a 44 px ×, the message, and its actions under it. */
export function PinnedNotice({
  label,
  closeLabel = "Dismiss. This message won't come back",
  onClose,
  actions,
  children,
}: {
  label: string
  closeLabel?: string
  /** Without it the card has no ×; a message's last state may end only through its action. */
  onClose?: () => void
  /** The buttons, primary first. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    // 2a: 4/4/14/16 padding, 16 radius, the .16 hairline over a near-opaque
    // fill, its drop shadow and top glint, a 12 px blur.
    <section
      role="status"
      aria-label={label}
      className="flex w-full flex-col gap-2.5 rounded-[16px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] pb-3.5 pl-4 pr-1 pt-1 text-left shadow-[0_14px_36px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.05)] backdrop-blur-[12px]"
    >
      <div className="flex min-h-11 items-center">
        <span className="flex-1 font-mono text-[10.5px] tracking-[0.16em] text-[rgba(160,190,225,.65)]">{label}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="grid h-11 w-11 place-items-center text-[18px] text-[rgba(160,190,225,.7)]"
          >
            ×
          </button>
        )}
      </div>
      {/* 2a: the message tucks 6 px up under the header's 44 px target. */}
      <div className="-mt-1.5 flex flex-col">{children}</div>
      {actions && <div className="flex gap-2 pr-3 pt-3">{actions}</div>}
    </section>
  )
}

/** A message's sentence (2a): 14 px at 1.45, 14 px clear of the right edge. */
export function PinnedNoticeText({ children }: { children: ReactNode }) {
  return <p className="pr-3.5 text-[14px] leading-[1.45] text-[rgba(214,226,242,.94)] [text-wrap:pretty]">{children}</p>
}

/**
 * A notice's action, sharing its row with the others (2a): `lit` is the
 * active-chip treatment the primary uses, never the accent fill; otherwise
 * the quiet hairline.
 */
export function NoticeButton({
  lit = false,
  disabled,
  onClick,
  children,
}: {
  lit?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'h-11 flex-1 rounded-[12px] border text-[14px] font-semibold disabled:opacity-40',
        lit
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(220,235,255,.85)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
