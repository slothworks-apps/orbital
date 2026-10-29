import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { firstReleaseNotes, releaseNotes, releaseNotesSince, type ReleaseNotes } from '@orbital/shared/changelog'
import changelog from '../../../mobile/CHANGELOG.md?raw'
import {
  endedSeenVersion, parseSeenVersion, serializeSeenVersion, whatsNewHead, whatsNewOnLaunch, type SeenVersion,
} from '../lib/whatsNew'
import { ReleaseNoteVersions } from '../ui/ReleaseNotes'
import { usePhoneNotices } from './notices'
import { NoticeButton, PinnedNotice, PinnedNoticeList } from './PinnedNotice'
import { readWhatsNew, writeWhatsNew } from './platform/whatsNew'
import { BottomSheet, SHEET_EXIT_MS, SheetPresence } from './ui'

/**
 * WHAT'S NEW on the phone (spec 2026-10-19-whats-new-design § The phone;
 * canvas `Feature - Notice toast` 2a, 2b): the `changelog` message of the
 * phone's own queue, once after its app version changed, with the first
 * lines of `mobile/CHANGELOG.md` since the version the phone ran before —
 * this version's first, then any it skipped — and See all changes for the
 * rest in a sheet. It needs nothing from the Mac. What the
 * phone has seen is its own, in its preferences.
 */

const WHATS_NEW_NOTICE_ID = 'whats-new'

/**
 * The phone's app version, read when asked: a module-level read of the
 * build-time global would throw in any test that imports this file.
 */
const appVersion = (): string => __MOBILE_VERSION__

interface PhoneWhatsNewState {
  /**
   * This launch's decision: undefined until read, then whether it is due,
   * since when, and what it tells, newest first.
   */
  launch: { version: string; due: boolean; installedAt: number; notes: ReleaseNotes[] } | undefined
}


const usePhoneWhatsNewState = create<PhoneWhatsNewState>()(() => ({ launch: undefined }))

let deciding = false

function remember(seen: SeenVersion): void {
  // A failed write costs the message once more next launch, not an error.
  writeWhatsNew(serializeSeenVersion(seen)).catch((err: unknown) =>
    console.warn('[mobile] could not store what’s new', err),
  )
}

/**
 * Decides once per launch, from what boot read before any screen: whether
 * this phone was in use already (`usedBefore`: a group or pairing, or what a
 * pairing that ended leaves behind). With nothing remembered, such a phone
 * was updated from a version before WHAT'S NEW, not installed afresh. Read at
 * boot, not when the list first shows, so a first pairing is not taken for
 * an update.
 */
export async function decideWhatsNew(usedBefore: boolean): Promise<void> {
  if (deciding) return
  deciding = true
  const version = appVersion()
  let stored: string | null
  try {
    stored = await readWhatsNew()
  } catch {
    // Unreadable: nothing is decided, and nothing is overwritten.
    return
  }
  // What the phone ran before is read here, before `remember` writes the
  // running version over it; `launch.since` carries it.
  const launch = whatsNewOnLaunch({
    stored: parseSeenVersion(stored, usedBefore),
    version,
    hasNotes: releaseNotes(changelog, version) !== null,
    now: Date.now(),
  })
  usePhoneWhatsNewState.setState({
    launch: {
      version,
      due: launch.show,
      installedAt: launch.installedAt,
      notes: launch.show ? releaseNotesSince(changelog, version, launch.since) : [],
    },
  })
  if (launch.write) remember(launch.write)
}

/** Keeps the message in the phone's queue while it is due. Mounted by the session list. */
export function usePhoneWhatsNew(): void {
  const due = usePhoneWhatsNewState((s) => s.launch?.due ?? false)
  useEffect(() => {
    const notices = usePhoneNotices.getState()
    if (due) notices.push({ id: WHATS_NEW_NOTICE_ID, kind: 'changelog', Body: WhatsNewNotice })
    else notices.dismiss(WHATS_NEW_NOTICE_ID)
  }, [due])
}

/** For the update demo: the message as after an update, whatever the phone remembers. */
export function showPhoneWhatsNewDemo(): void {
  deciding = true
  const version = appVersion()
  usePhoneWhatsNewState.setState({
    launch: { version, due: true, installedAt: Date.now(), notes: releaseNotesSince(changelog, version) },
  })
}

function WhatsNewNotice({ close }: { close: () => void }) {
  const launch = usePhoneWhatsNewState((s) => s.launch)
  const [open, setOpen] = useState(false)
  if (!launch || launch.notes.length === 0) return null
  const { notes } = launch

  // × on the toast, or the sheet closed by Done, ×, the backdrop or back:
  // gone for good. A closing sheet sinks first; the toast leaves after it.
  const end = () => {
    remember(endedSeenVersion(launch.version, launch.installedAt))
    const leave = () => {
      usePhoneWhatsNewState.setState({ launch: { ...launch, due: false } })
      close()
    }
    if (!open) return leave()
    setOpen(false)
    setTimeout(leave, SHEET_EXIT_MS)
  }

  return (
    <>
      <PinnedNotice
        label={whatsNewHead(launch.version)}
        onClose={end}
        actions={
          <NoticeButton lit onClick={() => setOpen(true)}>
            See all changes
          </NoticeButton>
        }
      >
        <PinnedNoticeList items={firstReleaseNotes(notes)} />
      </PinnedNotice>
      <SheetPresence>
        {open && (
          <BottomSheet label="What's new" variant="notes" onDismiss={end} swipeToDismiss>
            {/* 2b: 4/8/14/22, ruled off; the title block 6 px down. */}
            <div className="flex shrink-0 items-start border-b border-line/10 pb-3.5 pl-[22px] pr-2 pt-1">
              <div className="flex-1 pt-1.5">
                <div className="font-mono fs-10.5 tracking-[0.2em] text-ink-900/65">WHAT’S NEW</div>
                <h2 className="mt-1.5 fs-20 font-bold text-ink-100">Orbital {launch.version}</h2>
              </div>
              <button
                type="button"
                onClick={end}
                aria-label="Close"
                className="grid h-11 w-11 place-items-center fs-18 text-ink-900/70"
              >
                ×
              </button>
            </div>
            {/* 2b: 20 between sections, 18/22. */}
            <div data-sheet-scroll className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[22px] py-[18px]">
              <ReleaseNoteVersions notes={notes} gap="gap-5" ruled="pt-5" />
            </div>
            {/* 2b: 10/16 over Done; the sheet's own bottom inset stands for the home indicator. */}
            <div className="flex shrink-0 border-t border-line/8 px-4 pb-1.5 pt-2.5">
              <NoticeButton lit size="sheet" onClick={end}>
                Done
              </NoticeButton>
            </div>
          </BottomSheet>
        )}
      </SheetPresence>
    </>
  )
}
