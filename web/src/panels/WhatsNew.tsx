import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { WHATS_NEW_SEEN_KEY, firstReleaseNotes, releaseNotes } from '@orbital/shared/changelog'
import changelog from '../../../desktop/CHANGELOG.md?raw'
import { version as orbitalVersion } from '../../../desktop/package.json'
import { api } from '../lib/api'
import { receiptLine, releaseNotesUrl } from '../lib/appUpdate'
import {
  endedSeenVersion, installedLine, parseSeenVersion, serializeSeenVersion, whatsNewHead, whatsNewOnLaunch,
  type SeenVersion,
} from '../lib/whatsNew'
import { useAppUpdate } from '../store/appUpdate'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { MapNotice, MapNoticeList, MapNoticeText } from '../ui/MapNotice'
import {
  EXITING, MODAL_CLOSED, MODAL_ENTER_DURATION, MODAL_ENTER_MS, MODAL_EXIT_DURATION, MODAL_EXIT_MS, MODAL_OPEN,
  MODAL_TRANSITION, SCRIM_CLOSED, SCRIM_OPEN,
} from '../ui/motion'
import { ReleaseNoteSections } from '../ui/ReleaseNotes'
import { usePresence } from '../ui/usePresence'

/**
 * WHAT'S NEW on the Mac (spec 2026-10-19-whats-new-design; canvas `Feature -
 * Notice toast` 1a, 1b, and `Feature - Remote update` 50v 04): the `changelog`
 * message of the map's notice queue, once after the version changes, with
 * the first lines of this version's section of `desktop/CHANGELOG.md` and
 * See all changes for the rest. After another member updated this Mac, who
 * and when heads it, and its end clears that receipt.
 *
 * What this Mac has seen is a server setting (`WHATS_NEW_SEEN_KEY`), beside
 * the notifications tip's; the server's migration marks an install from
 * before WHAT'S NEW, so it is told too.
 */

const WHATS_NEW_NOTICE_ID = 'whats-new'

/** This version's notes, read once from the bundled changelog. */
const NOTES = releaseNotes(changelog, orbitalVersion)

interface WhatsNewState {
  /** Whether this launch has decided yet. */
  decided: boolean
  /** The message is due: the version changed and it has not ended. */
  due: boolean
  /** When this Mac first ran this version. */
  installedAt: number
  /**
   * × or Done was pressed: the message stays out of the queue, although main
   * clears the receipt a moment later — without it the receipt still there
   * would queue it again.
   */
  ended: boolean
}

const useWhatsNew = create<WhatsNewState>()(() => ({ decided: false, due: false, installedAt: Date.now(), ended: false }))

function remember(seen: SeenVersion): void {
  const value = serializeSeenVersion(seen)
  useOrbital.setState((state) => ({ settings: { ...state.settings, [WHATS_NEW_SEEN_KEY]: value } }))
  // A failed write costs the message once more next launch, not an error.
  api.patchSettings({ [WHATS_NEW_SEEN_KEY]: value }).catch(() => {})
}

/**
 * Decides once the server's settings are in, and keeps the message in the
 * map's queue while it is due or a receipt waits. Mounted by `App`.
 */
export function useWhatsNewNotice(): void {
  const loaded = useOrbital((s) => s.settingsLoaded === true)
  useEffect(() => {
    if (!loaded || useWhatsNew.getState().decided) return
    const launch = whatsNewOnLaunch({
      stored: parseSeenVersion(useOrbital.getState().settings[WHATS_NEW_SEEN_KEY]),
      version: orbitalVersion,
      hasNotes: NOTES !== null,
      now: Date.now(),
    })
    useWhatsNew.setState({ decided: true, due: launch.show, installedAt: launch.installedAt })
    if (launch.write) remember(launch.write)
  }, [loaded])

  const due = useWhatsNew((s) => s.due)
  const ended = useWhatsNew((s) => s.ended)
  // After a restart another member made (canvas 50v 04), even with no notes
  // to show, until the message ends — which main remembers.
  const receipt = useAppUpdate((s) => (s.state?.receipt ? true : false))
  useEffect(() => {
    const notices = useMapNotices.getState()
    if (!ended && (due || receipt)) notices.push({ id: WHATS_NEW_NOTICE_ID, kind: 'changelog', Body: WhatsNewNotice })
    else notices.dismiss(WHATS_NEW_NOTICE_ID)
  }, [due, receipt, ended])
}

/** For the update demo: the message as after an update, whatever this Mac remembers. */
export function showWhatsNewDemo(): void {
  useWhatsNew.setState({ decided: true, due: true, installedAt: Date.now(), ended: false })
}

function WhatsNewNotice({ close }: { close: () => void }) {
  const receipt = useAppUpdate((s) => s.state?.receipt ?? null)
  const source = useAppUpdate((s) => s.source)
  const installedAt = useWhatsNew((s) => s.installedAt)
  const [open, setOpen] = useState(false)

  // × on the toast or the dialog closed: gone for good, and the receipt with
  // it. A closing dialog plays its exit first; the toast leaves after it.
  const end = () => {
    remember(endedSeenVersion(orbitalVersion, installedAt))
    const leave = () => {
      useWhatsNew.setState({ due: false, ended: true })
      if (receipt) source?.updateAction('receipt-close')
      close()
    }
    if (!open) return leave()
    setOpen(false)
    setTimeout(leave, MODAL_EXIT_MS)
  }

  return (
    <>
      <MapNotice
        label={whatsNewHead(orbitalVersion)}
        onClose={end}
        actions={
          NOTES && (
            <Button variant="lit" size="notice" onClick={() => setOpen(true)}>
              See all changes
            </Button>
          )
        }
      >
        {receipt && <MapNoticeText>{receiptLine(receipt)}</MapNoticeText>}
        {NOTES && <MapNoticeList items={firstReleaseNotes(NOTES)} />}
      </MapNotice>
      {NOTES && <WhatsNewDialog open={open} installedAt={installedAt} onClose={end} />}
    </>
  )
}

/**
 * See all changes (1b): the version's sections in a centred dialog over a
 * dimmed map, its release on GitHub, and Done. Closing it ends the message.
 */
function WhatsNewDialog({ open, installedAt, onClose }: { open: boolean; installedAt: number; onClose: () => void }) {
  useEscapeLayer(open, onClose)
  const { mounted, state } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)
  if (!mounted || !NOTES) return null
  const entered = state === 'entered'
  const duration = state === 'exiting' ? MODAL_EXIT_DURATION : MODAL_ENTER_DURATION

  return createPortal(
    <EscapeBoundary>
      <div
        inert={state === 'exiting' || undefined}
        className={[
          // 1b: the map dimmed at .55 under a 3 px blur.
          'orbital-no-drag fixed inset-0 z-50 flex items-center justify-center bg-space/55 p-6 backdrop-blur-[3px]',
          MODAL_TRANSITION,
          duration,
          entered ? SCRIM_OPEN : SCRIM_CLOSED,
          state === 'exiting' ? EXITING : '',
        ].join(' ')}
      >
        {/* 1b: 620 wide, 16 radius, the .2 hairline over the dialog gradient, its shadow and top glint. */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What's new"
          className={[
            'flex max-h-full w-[620px] max-w-full flex-col rounded-2xl border border-line/20 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-raised)_96%,_transparent),color-mix(in_oklab,_var(--color-space-deep)_98%,_transparent))] font-sans text-ink-100 shadow-[0_30px_80px_color-mix(in_oklab,_var(--color-shadow)_60%,_transparent),inset_0_1px_0_color-mix(in_oklab,_var(--color-highlight)_7%,_transparent)]',
            MODAL_TRANSITION,
            duration,
            entered ? MODAL_OPEN : MODAL_CLOSED,
          ].join(' ')}
        >
          {/* 1b: 22/20/16/28, ruled off. */}
          <header className="flex shrink-0 items-start gap-3 border-b border-line/10 pb-4 pl-7 pr-5 pt-[22px]">
            <div className="flex-1">
              <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/65">WHAT’S NEW</div>
              <h2 className="mt-1.5 fs-20 font-bold tracking-[-0.01em]">Orbital {orbitalVersion}</h2>
              <div className="mt-1 font-mono fs-11 text-ink-900/55">
                {installedLine(installedAt, Date.now())}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-[30px] w-[30px] place-items-center rounded-[7px] fs-16 text-ink-900/70 transition-colors hover:bg-line/8 hover:text-ink-100"
            >
              ×
            </button>
          </header>
          {/* 1b: 22 between sections, 22/28/24, scrolling past 440. */}
          <div className="flex max-h-[440px] min-h-0 flex-col gap-[22px] overflow-y-auto px-7 pb-6 pt-[22px]">
            <ReleaseNoteSections sections={NOTES.sections} />
          </div>
          {/* 1b: 14/20/16/28, ruled off. */}
          <footer className="flex shrink-0 items-center gap-2 border-t border-line/10 pb-4 pl-7 pr-5 pt-3.5">
            <a
              href={releaseNotesUrl(orbitalVersion)}
              target="_blank"
              rel="noreferrer"
              className="font-mono fs-11 tracking-[0.06em] text-ink-900/75 no-underline transition-colors hover:text-ink-100"
            >
              Release notes on GitHub ↗
            </a>
            <span className="flex-1" />
            <Button variant="lit" size="notice-dialog" onClick={onClose}>
              Done
            </Button>
          </footer>
        </div>
      </div>
    </EscapeBoundary>,
    document.body,
  )
}
