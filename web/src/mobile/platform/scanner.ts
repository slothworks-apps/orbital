import { Capacitor } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'

/**
 * `installing`: the scanner exists but its module is still on the way, so
 * Scan works again in a moment. `unsupported`: no scanner at all here, and
 * 9e falls back to the paste field.
 */
export type ScanResult =
  | { kind: 'code'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'installing' }
  | { kind: 'unsupported' }

/**
 * The system's ready-made scanner (ML Kit through Google Play services). No
 * camera API — a desktop browser, a phone without ML Kit — answers
 * `unsupported`; a phone still fetching the module answers `installing`
 * (spec § 1).
 */
export async function scanQr(): Promise<ScanResult> {
  if (!Capacitor.isNativePlatform()) return { kind: 'unsupported' }
  try {
    const { supported } = await BarcodeScanner.isSupported()
    if (!supported) return { kind: 'unsupported' }
    if (Capacitor.getPlatform() === 'android') {
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
      if (!available) {
        // Play services fetch the module in the background; Scan works once it lands.
        await BarcodeScanner.installGoogleBarcodeScannerModule()
        return { kind: 'installing' }
      }
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
    const text = barcodes[0]?.rawValue
    return text ? { kind: 'code', text } : { kind: 'cancelled' }
  } catch {
    // The user backed out of the scanner, or the module is still installing.
    return { kind: 'cancelled' }
  }
}
