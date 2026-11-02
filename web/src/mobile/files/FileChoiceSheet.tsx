import { create } from 'zustand'
import type { FileChoice } from '../../lib/fileOpen'
import { matchCount, shownMatches, splitDir } from '../../lib/findByName'
import { SHEET_LABEL } from '../menu/TagSheet'
import { BottomSheet, SheetPresence } from '../ui'
import { PageGlyph } from '../../ui/UtilityButton'

/**
 * A bare name's matches on the phone (spec
 * 2026-11-02-bare-file-names-and-path-menu-design § The phone; canvas
 * `Feature - Path menu glyphs` 1f): the 10i ⋯ sheet — same handle, mono
 * title, 52 px rows. A tap on a row opens that file's text preview; a tap on
 * the scrim only closes the sheet. It picks a file and offers no actions:
 * copying is the long-press on the chip, as before. The sheet scrolls, so it
 * lists every match the server returned; only the ones past those are a count.
 */

export const useFileChoice = create<{ shown: FileChoice | null }>(() => ({ shown: null }))

export function showFileChoice(choice: FileChoice): void {
  useFileChoice.setState({ shown: choice })
}

function close(): void {
  useFileChoice.setState({ shown: null })
}

export function FileChoiceSheet() {
  const shown = useFileChoice((s) => s.shown)
  return <SheetPresence>{shown && <ChoiceSheet shown={shown} />}</SheetPresence>
}

/** 1f's inert line under the rows: `+N more`, or the one fact a choice without rows has. */
function Fact({ text, inset = true }: { text: string; inset?: boolean }) {
  return (
    <div
      className={[
        'flex h-11 items-center pr-2.5 font-mono fs-12 text-ink-900/50',
        inset ? 'pl-[42px]' : 'pl-2.5',
      ].join(' ')}
    >
      {text}
    </div>
  )
}

function ChoiceSheet({ shown }: { shown: FileChoice }) {
  const { choice } = shown
  let head = choice.name
  let body
  if (choice.kind === 'matches') {
    const { rows, more } = shownMatches(choice, true)
    const count = matchCount(choice)
    head = `${choice.name} · ${count} ${count === 1 ? 'match' : 'matches'}`
    body = (
      <>
        {rows.map((match) => {
          const { dir, name } = splitDir(match.relative)
          return (
            // canvas 1f: the 10i row — 52 px, the glyph in a 20 px column, mono path, `touched` at the end.
            <button
              key={match.path}
              type="button"
              onClick={() => {
                close()
                shown.open(match)
              }}
              className="flex h-13 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-ink-100"
            >
              <span aria-hidden className="grid w-5 flex-none place-items-center text-ink-500/75">
                <PageGlyph size="sheet" />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono fs-13">
                <span className="text-ink-900/65">{dir}</span>
                {name}
              </span>
              {match.touched && <span className="font-mono fs-11 text-ink-900/55">touched</span>}
            </button>
          )
        })}
        {more > 0 && <Fact text={`+${more} more · ask Claude for the full path`} />}
      </>
    )
  } else if (choice.kind === 'none') {
    body = <Fact text={`no file by that name under ${choice.under}`} inset={false} />
  } else {
    body = (
      <>
        <Fact text={`${choice.device} didn't answer`} inset={false} />
        {/* 1f draws no give-up state; the row is 1f's matches row (52 px, gap 12, 0 10px, r10, the sheet's 14 px ink), label in place of the path. */}
        <button
          type="button"
          onClick={() => {
            close()
            shown.retry()
          }}
          className="flex h-13 w-full items-center gap-3 rounded-[10px] px-2.5 text-left fs-14 text-ink-100"
        >
          <span aria-hidden className="w-5 flex-none" />
          Try again
        </button>
      </>
    )
  }
  return (
    <BottomSheet label={`Files named ${choice.name}`} onDismiss={close}>
      <div className={['truncate uppercase', SHEET_LABEL].join(' ')}>{head}</div>
      {body}
      {/* canvas 1f: the sheet's foot above the home indicator, as 10i's. */}
      <div className="h-4" />
    </BottomSheet>
  )
}
