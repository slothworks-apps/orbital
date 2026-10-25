import type { ReactNode } from 'react'

/**
 * The quiet PRIMARY beside the group's primary (canvas 50a ROWS, 50i): on
 * its row, or on THIS DEVICE when you are on it. A label, never a hue: the
 * same hairline and ink on the desktop and the phone.
 */
export function PrimaryLabel() {
  return <QuietLabel>PRIMARY</QuietLabel>
}

/**
 * The pill PRIMARY is drawn in, for any word that marks a row without
 * colouring it: Settings' THIS MAC ONLY (canvas `Feature - Shared settings`
 * 63c) is the same pill.
 */
export function QuietLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-[4px] border border-[rgba(150,205,255,.22)] px-[5px] pb-[2px] pt-[3px] font-mono text-[9px] leading-none tracking-[0.16em] text-[rgba(200,220,245,.78)]">
      {children}
    </span>
  )
}
