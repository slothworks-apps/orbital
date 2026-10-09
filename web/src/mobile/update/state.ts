import { create } from 'zustand'

/**
 * The phone's over-the-air update as the user meets it (spec
 * 2026-10-09-phone-ota-updates-design → The app; canvas `Feature - Phone
 * update`): a bundle the plugin finished downloading becomes the UPDATE
 * notice on the session list, READY with Restart; × turns it into a one-line
 * receipt (AFTER ×) whose OK ends it. Restart shows the restart frame and
 * reloads into the bundle; closing leaves the bundle for the next time the app
 * starts. Each version is offered once.
 *
 * The plugin, the stored answers and the reload are behind `UpdateSource`
 * (`platform.ts` on a phone, `demo.ts` in a browser), so this holds no
 * Capacitor.
 */

export interface DownloadedBundle {
  /** The plugin's id for the downloaded bundle; `set` takes it. */
  id: string
  version: string
}

export type UpdatePhase = 'ready' | 'closed' | 'restarting'

export interface ShownUpdate {
  phase: UpdatePhase
  bundle: DownloadedBundle
}

export interface UpdateSource {
  /** Reloads into the bundle now; a failure rejects. */
  restart(bundle: DownloadedBundle): Promise<void>
  /** Leaves the bundle for the next time the app starts. */
  later(bundle: DownloadedBundle): Promise<void>
  /** Remembers that this version has been answered, so it is not offered again. */
  answered(version: string): Promise<void>
}

export type DownloadVerdict = 'prompt' | 'quietly-later' | 'ignore'

/**
 * What a finished download means:
 *
 * - the version this app already runs — a fresh store install offered the
 *   bundle it carries built in — is the same code: it is taken quietly at the
 *   next start, with no prompt (`quietly-later`);
 * - a version already answered, or a download while the app restarts, is
 *   left alone;
 * - anything else is offered, replacing an unanswered offer of another
 *   version: the newer download wins.
 */
export function downloadVerdict(input: {
  bundle: DownloadedBundle
  running: string
  answered: string | null
  shown: ShownUpdate | null
}): DownloadVerdict {
  const { bundle, running, answered, shown } = input
  if (shown?.phase === 'restarting') return 'ignore'
  if (bundle.version === running) return 'quietly-later'
  if (bundle.version === answered) return 'ignore'
  if (shown?.phase === 'closed' && shown.bundle.version === bundle.version) return 'ignore'
  return 'prompt'
}

interface PhoneUpdateState {
  shown: ShownUpdate | null
  /** The last version answered, as stored; null when none or not read yet. */
  answered: string | null
  /** The shell's native version, for Settings' footer; null until read, and in a browser. */
  shell: string | null
  source: UpdateSource | null
  connect(source: UpdateSource, answered: string | null): void
  downloaded(bundle: DownloadedBundle, running: string): void
  restart(): void
  close(): void
  ok(): void
}

const warn = (what: string) => (err: unknown) =>
  console.warn(`[mobile] update: could not ${what}`, err)

export const usePhoneUpdate = create<PhoneUpdateState>()((set, get) => ({
  shown: null,
  answered: null,
  shell: null,
  source: null,

  connect: (source, answered) => set({ source, answered }),

  downloaded: (bundle, running) => {
    const { shown, answered, source } = get()
    const verdict = downloadVerdict({ bundle, running, answered, shown })
    if (verdict === 'prompt') set({ shown: { phase: 'ready', bundle } })
    else if (verdict === 'quietly-later')
      source?.later(bundle).catch(warn('keep the bundle for the next start'))
  },

  restart: () => {
    const { shown, source } = get()
    if (shown?.phase !== 'ready' || !source) return
    const { bundle } = shown
    set({ shown: { phase: 'restarting', bundle }, answered: bundle.version })
    void (async () => {
      await source.answered(bundle.version).catch(warn('store the answer'))
      try {
        await source.restart(bundle)
      } catch (err) {
        // The bundle could not be switched to: nothing more is offered for it.
        warn('restart into the bundle')(err)
        set({ shown: null })
      }
    })()
  },

  close: () => {
    const { shown, source } = get()
    if (shown?.phase !== 'ready' || !source) return
    const { bundle } = shown
    set({ shown: { phase: 'closed', bundle }, answered: bundle.version })
    source.answered(bundle.version).catch(warn('store the answer'))
    source.later(bundle).catch(warn('keep the bundle for the next start'))
  },

  ok: () => {
    if (get().shown?.phase === 'closed') set({ shown: null })
  },
}))
