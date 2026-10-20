import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { osName } from '@orbital/shared/remote/device'
import { osLabel } from '@orbital/shared/remote/groupWords'
import { issueUrl, phoneReport, type PhoneEnvironment, type PhoneReportKind } from '../../lib/issueReport'
import { thisDevice } from '../platform/device'
import { BottomSheet, CARD } from '../ui'

const OS = osLabel(osName(Capacitor.getPlatform()))

const CHOICES: readonly { kind: PhoneReportKind; title: string; desc: string }[] = [
  { kind: 'broke', title: 'Something broke', desc: `Bug report, with the app and ${OS} version filled in` },
  { kind: 'idea', title: 'An idea', desc: 'Feature request' },
]

/**
 * The phone's facts a bug report carries (61g PHONE), from the same read the
 * device list and the hello make — no plugin or permission of its own.
 */
async function phoneEnvironment(): Promise<PhoneEnvironment> {
  const device = await thisDevice()
  return { app: __MOBILE_VERSION__, os: device.osVersion ?? OS, model: device.model ?? '' }
}

/**
 * `Feature - Feedback` 61i: Settings → Send feedback. A choice opens
 * GitHub's new-issue form, prefilled, in the system browser (Capacitor hands
 * `window.open` to it), and the sheet closes. Nothing goes through the Mac.
 */
export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  // Read as the sheet opens, so a tap opens the browser at once, inside its
  // gesture; until it is read, the report names the app and the system alone.
  const [env, setEnv] = useState<PhoneEnvironment>({ app: __MOBILE_VERSION__, os: OS, model: '' })
  useEffect(() => {
    let current = true
    void phoneEnvironment().then((read) => current && setEnv(read))
    return () => {
      current = false
    }
  }, [])

  const choose = (kind: PhoneReportKind) => {
    const { title, body } = phoneReport(kind, env)
    window.open(issueUrl(title, body).url, '_blank', 'noopener')
    onClose()
  }

  return (
    <BottomSheet label="Send feedback" variant="feedback" onDismiss={onClose}>
      {/* 61i: the head 4/0/12/6 with a 44 px × at its right. */}
      <div className="flex items-center pb-3 pl-1.5 pt-1">
        <div className="flex-1 font-mono text-[10.5px] tracking-[0.2em] text-[rgba(160,190,225,.65)]">SEND FEEDBACK</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-11 w-11 place-items-center text-[18px] text-[rgba(160,190,225,.7)]"
        >
          ×
        </button>
      </div>
      <div className={CARD}>
        {CHOICES.map((choice, i) => (
          <button
            key={choice.kind}
            type="button"
            onClick={() => choose(choice.kind)}
            className={[
              'flex min-h-16 w-full flex-col justify-center gap-[3px] px-3.5 py-2.5 text-left',
              i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : '',
            ].join(' ')}
          >
            <span className="text-[15px] font-semibold">{choice.title}</span>
            <span className="text-[12px] text-[rgba(160,190,225,.65)]">{choice.desc}</span>
          </button>
        ))}
      </div>
      <p className="px-1.5 pt-3 text-[12px] leading-[1.5] text-pretty text-[rgba(160,190,225,.65)]">
        Opens the new-issue form on GitHub in your browser. It's public; you review and send it there.
      </p>
    </BottomSheet>
  )
}
