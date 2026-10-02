import { Capacitor } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { generateIdentity, type Identity } from '@orbital/shared/remote/keys'
import { identityBackend, parseIdentity, serializeIdentity } from './parse'

/**
 * This phone's Ed25519 identity (spec § 4): lost only by an uninstall or by
 * "Pair a different Mac". In the Android Keystore through secure storage;
 * in a desktop browser, in `localStorage` — unprotected, for development only,
 * and the pairing screen says so (`identityIsDevOnly`).
 */
export const IDENTITY_KEY = 'orbital.identity'

interface SecretStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
  remove(): Promise<void>
}

function store(): SecretStore {
  if (identityBackend(Capacitor.isNativePlatform()) === 'secure') {
    return {
      get: () => SecureStorage.getItem(IDENTITY_KEY),
      set: (value) => SecureStorage.setItem(IDENTITY_KEY, value),
      remove: () => SecureStorage.removeItem(IDENTITY_KEY),
    }
  }
  return {
    get: () => Promise.resolve(localStorage.getItem(IDENTITY_KEY)),
    set: (value) => {
      localStorage.setItem(IDENTITY_KEY, value)
      return Promise.resolve()
    },
    remove: () => {
      localStorage.removeItem(IDENTITY_KEY)
      return Promise.resolve()
    },
  }
}

// One read at a time: two first-launch callers must not each mint a key.
let loading: Promise<Identity> | null = null

export function loadOrCreateIdentity(): Promise<Identity> {
  if (loading) return loading
  const current = (async () => {
    const secrets = store()
    const existing = parseIdentity(await secrets.get())
    if (existing) return existing
    const fresh = generateIdentity()
    await secrets.set(serializeIdentity(fresh))
    return fresh
  })()
  loading = current
  // A failed read (a Keystore hiccup) is not remembered: the next call tries again.
  current.catch(() => {
    if (loading === current) loading = null
  })
  return current
}

export async function forgetIdentity(): Promise<void> {
  loading = null
  await store().remove()
}

export function identityIsDevOnly(): boolean {
  return identityBackend(Capacitor.isNativePlatform()) === 'local'
}
