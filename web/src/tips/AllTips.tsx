import { useEffect, useRef } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { allTipsMeta, groupTips } from '../lib/tips'
import { TIPS } from './tipList'
import { markTipsSeen, runTipAction, useSeenTips } from './useTips'

/** The error log's frame stops here (canvas 5b, 68d); past it the list scrolls inside. */
const ALL_TIPS_MAX_HEIGHT = 720

const GROUPS = groupTips(TIPS)

/**
 * All tips (spec 2026-11-16-tips-design § What it opens; canvas `Feature -
 * Tips` 68d): the error log's dialog shell, TIPS / All tips, every tip under
 * its heading. Opening it counts as seeing every tip, so the bulb's dot goes;
 * the ones that were new when it opened keep their mark until it closes.
 */
export function AllTips({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { seen } = useSeenTips()
  // Which tips were new, taken as it opens: marking them seen must not take
  // the marks off the rows being read.
  const fresh = useRef<ReadonlySet<string>>(new Set())
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) {
    fresh.current = new Set(TIPS.filter((tip) => !seen.has(tip.id)).map((tip) => tip.id))
  }
  wasOpen.current = open

  useEffect(() => {
    if (open) markTipsSeen(TIPS.map((tip) => tip.id))
  }, [open])

  return (
    <Dialog
      open={open}
      title="All tips"
      eyebrow="TIPS"
      size="xl"
      maxHeight={ALL_TIPS_MAX_HEIGHT}
      onClose={onClose}
      headerMeta={allTipsMeta(TIPS.length, fresh.current.size)}
      footerCaption="new tips arrive with updates · • marks the ones you haven’t seen"
      footer={
        <Button variant="primary" size="lg" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="-mt-2 flex flex-col gap-1.5">
        {GROUPS.map(({ group, tips }) => (
          <section key={group} aria-label={group} className="flex flex-col gap-1.5">
            <h3 className="m-0 px-0.5 pb-1 pt-3 font-mono fs-9.5 font-normal uppercase tracking-[0.18em] text-ink-900/60">
              {group}
            </h3>
            {tips.map((tip) => {
              const isNew = fresh.current.has(tip.id)
              return (
                // 68d: a new tip has the accent dot and a lit surface, like
                // an unseen error row without the red.
                <div
                  key={tip.id}
                  data-new={isNew || undefined}
                  className={[
                    'flex items-start gap-3 rounded-[9px] border px-3.5 py-3',
                    isNew ? 'border-line/20 bg-line/5' : 'border-line/8 bg-space/35',
                  ].join(' ')}
                >
                  <span
                    aria-hidden
                    className={['mt-2 h-1.5 w-1.5 flex-none rounded-full', isNew ? 'bg-accent' : 'bg-ink-900/25'].join(' ')}
                  />
                  <p className="m-0 min-w-0 flex-1 fs-13.5 leading-[1.55] text-pretty text-ink-100/92">
                    {isNew && <span className="sr-only">New: </span>}
                    {tip.text}
                  </p>
                  {tip.action && (
                    <Button
                      variant="outline-soft"
                      size="labs-row"
                      className="mt-px flex-none whitespace-nowrap"
                      onClick={() => {
                        // Using an action closes the dialog (68d ACTIONS IN THE LIST).
                        onClose()
                        if (tip.action) runTipAction(tip.action)
                      }}
                    >
                      <span className="inline-flex items-center gap-[7px]">
                        {tip.action.label}
                        <span aria-hidden className="text-ink-900/60">
                          →
                        </span>
                      </span>
                    </Button>
                  )}
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </Dialog>
  )
}
