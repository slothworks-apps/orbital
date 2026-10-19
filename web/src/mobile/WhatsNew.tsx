import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { firstReleaseNotes, releaseNotes, type ReleaseNotes } from '@orbital/shared/changelog'
import changelog from '../../../mobile/CHANGELOG.md?raw'
import {
  endedSeenVersion, parseSeenVersion, serializeSeenVersion, whatsNewHead, whatsNewOnLaunch, type SeenVersion,
} from '../lib/whatsNew'
import { ReleaseNoteSections } from '../ui/ReleaseNotes'
import { usePhoneNotices } from './notices'
import { NoticeButton, PinnedNotice, PinnedNoticeList } from './PinnedNotice'
import { readWhatsNew, writeWhatsNew } from './platform/whatsNew'
import { BottomSheet, SHEET_EXIT_MS, SheetPresence } from './ui'

/**
 * WHAT'S NEW on the phone (spec 2026-10-19-whats-new-design § The phone;
 * canvas `Feature - Notice toast` 2a, 2b): the `changelog` message of the
 * phone's own queue, once after its app version changed, with the first
 * lines of that version's section of `mobile/CHANGELOG.md` and See all
 * changes for the rest in a sheet. It needs nothing from the Mac. What the
 * phone has seen is its own, in its preferences.
 */

const WHATS_NEW_NOTICE_ID = 'whats-new'

/**
 * The phone's app version, read when asked: a module-level read of the
 * build-time global would throw in any test that imports this file.
 */
const appVersion = (): string => __MOBILE_VERSION__

interface PhoneWhatsNewState {
  /** This launch's decision: undefined until read, then whether it is due and since when. */
  launch: { version: string; due: boolean; installedAt: number } | undefined
}

/** The running version's notes, parsed once: `notesFor` keeps the last answer. */
let parsed: { version: string; notes: ReleaseNotes | null } | undefined
function notesFor(version: string): ReleaseNotes | null {
  if (parsed?.version !== version) parsed = { version, notes: releaseNotes(changelog, version) }
  return parsed.notes
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
  const launch = whatsNewOnLaunch({
    stored: parseSeenVersion(stored, usedBefore),
    version,
    hasNotes: notesFor(version) !== null,
    now: Date.now(),
  })
  usePhoneWhatsNewState.setState({ launch: { version, due: launch.show, installedAt: launch.installedAt } })
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
  usePhoneWhatsNewState.setState({ launch: { version: appVersion(), due: true, installedAt: Date.now() } })
}

function WhatsNewNotice({ close }: { close: () => void }) {
  const launch = usePhoneWhatsNewState((s) => s.launch)
  const [open, setOpen] = useState(false)
  const notes = launch ? notesFor(launch.version) : null
  if (!launch || !notes) return null

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
            <div className="flex shrink-0 items-start border-b border-[rgba(150,205,255,.1)] pb-3.5 pl-[22px] pr-2 pt-1">
              <div className="flex-1 pt-1.5">
                <div className="font-mono text-[10.5px] tracking-[0.2em] text-[rgba(160,190,225,.65)]">WHAT’S NEW</div>
                <h2 className="mt-1.5 text-[20px] font-bold text-text-bright">Orbital {launch.version}</h2>
              </div>
              <button
                type="button"
                onClick={end}
                aria-label="Close"
                className="grid h-11 w-11 place-items-center text-[18px] text-[rgba(160,190,225,.7)]"
              >
                ×
              </button>
            </div>
            {/* 2b: 20 between sections, 18/22. */}
            <div data-sheet-scroll className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[22px] py-[18px]">
              <ReleaseNoteSections sections={notes.sections} />
            </div>
            {/* 2b: 10/16 over Done; the sheet's own bottom inset stands for the home indicator. */}
            <div className="flex shrink-0 border-t border-[rgba(150,205,255,.08)] px-4 pb-1.5 pt-2.5">
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
