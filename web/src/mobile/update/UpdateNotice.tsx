import { useEffect } from 'react'
import { usePhoneNotices } from '../notices'
import { NoticeButton, PinnedNotice, PinnedNoticeText } from '../PinnedNotice'
import { usePhoneUpdate } from './state'

/**
 * The phone's UPDATE notice (canvas `Feature - Phone update`; spec
 * 2026-10-09-phone-ota-updates-design → The app): the notice toast's UPDATE
 * kind, first in the queue, pinned above the session list and nowhere else —
 * one arriving on a session waits until the list is back. Two states: READY,
 * with Restart; AFTER ×, a one-line receipt whose OK ends it for this
 * version. No progress, no colour, no sound.
 */

const UPDATE_NOTICE_ID = 'phone-update'

/** Keeps the message queued while there is an offer or a receipt to show. Mounted by `MobileApp`. */
export function usePhoneUpdateNotice(): void {
  const showing = usePhoneUpdate((s) => s.shown !== null && s.shown.phase !== 'restarting')
  useEffect(() => {
    const notices = usePhoneNotices.getState()
    if (showing) notices.push({ id: UPDATE_NOTICE_ID, kind: 'update', Body: PhoneUpdateNotice })
    else notices.dismiss(UPDATE_NOTICE_ID)
  }, [showing])
}

function PhoneUpdateNotice() {
  const shown = usePhoneUpdate((s) => s.shown)
  const restart = usePhoneUpdate((s) => s.restart)
  const close = usePhoneUpdate((s) => s.close)
  const ok = usePhoneUpdate((s) => s.ok)
  if (!shown) return null
  const v = shown.bundle.version
  const label = `UPDATE · ORBITAL MOBILE ${v}`

  if (shown.phase === 'closed') {
    return (
      <PinnedNotice
        label={label}
        actions={
          <NoticeButton lit onClick={ok}>
            OK
          </NoticeButton>
        }
      >
        <PinnedNoticeText>{v} will be used the next time the app starts.</PinnedNoticeText>
      </PinnedNotice>
    )
  }
  return (
    <PinnedNotice
      label={label}
      onClose={close}
      closeLabel={`Close. ${v} is used the next time the app starts`}
      actions={
        <NoticeButton lit disabled={shown.phase === 'restarting'} onClick={restart}>
          Restart
        </NoticeButton>
      }
    >
      <PinnedNoticeText>
        Version {v} is downloaded. Restarting takes a moment and keeps what you are typing.
      </PinnedNoticeText>
    </PinnedNotice>
  )
}
