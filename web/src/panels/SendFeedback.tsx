import { MenuButton, type MenuEntry } from '../ui/Menu'

/** What Send feedback becomes: a bug report or a feature request. */
export type FeedbackKind = 'broke' | 'idea'

/** 61c's menu width. */
const MENU_WIDTH_PX = 272

/** A row of 61c's menu: what it is, and what it becomes. */
function Choice({ title, becomes }: { title: string; becomes: string }) {
  // 61c rows are 9/11 inset; `Menu`'s own row already gives 7/8, so the rest is here.
  return (
    <div className="flex flex-col gap-[3px] px-[3px] py-0.5 text-left">
      <span className="fs-13 font-semibold text-text-bright">{title}</span>
      <span className="fs-11.5 font-normal leading-[1.4] text-[rgba(160,190,225,.7)]">{becomes}</span>
    </div>
  )
}

/**
 * Send feedback in the Settings sidebar foot (spec
 * 2026-10-20-report-to-github-design § Web, canvas `Feature - Feedback` 61c):
 * an entry above the versions, not a tab. It opens the shared menu shell
 * upward with the one choice that matters, and the pick opens the review
 * dialog over Settings.
 */
export function SendFeedback({ onPick }: { onPick: (kind: FeedbackKind) => void }) {
  const entries: MenuEntry[] = [
    {
      key: 'broke',
      label: 'Something broke',
      body: <Choice title="Something broke" becomes="Becomes a bug report" />,
      onSelect: () => onPick('broke'),
    },
    {
      key: 'idea',
      label: 'An idea',
      body: <Choice title="An idea" becomes="Becomes a feature request" />,
      onSelect: () => onPick('idea'),
    },
  ]

  return (
    <MenuButton
      aria-label="Send feedback"
      entries={entries}
      prefer="above"
      align="left"
      widthPx={MENU_WIDTH_PX}
      footer={
        // 61c: under a hairline, the promise the review step keeps.
        <div className="mt-0.5 border-t border-[rgba(150,205,255,.08)] px-[11px] pb-[5px] pt-[7px] font-mono fs-10 leading-[1.5] text-[rgba(160,190,225,.55)]">
          You review it before anything is sent
        </div>
      }
      renderTrigger={(props, open) => (
        <button
          type="button"
          {...props}
          // 61c: a nav row's box (9/12, 8 radius, 13 px at 500); open, it
          // wears the selected row's fill and hairline.
          className={[
            'flex items-center gap-2.5 rounded-lg border px-3 py-[9px] text-left fs-13 font-medium transition-colors',
            open
              ? 'border-[rgba(150,205,255,.14)] bg-[rgba(150,205,255,.08)] text-text-bright'
              : 'border-transparent text-[rgba(220,235,255,.8)] hover:bg-[rgba(150,205,255,.06)] hover:text-text-bright',
          ].join(' ')}
        >
          Send feedback
        </button>
      )}
    />
  )
}
