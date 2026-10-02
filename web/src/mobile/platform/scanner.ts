import { Capacitor } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'

export type ScanResult = { kind: 'code'; text: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

/**
 * The system's ready-made scanner (ML Kit through Google Play services). No
 * camera API — a desktop browser, a phone without the module yet — answers
 * `unavailable`, and 9e offers the paste field instead (spec § 1).
 */
export async function scanQr(): Promise<ScanResult> {
  if (!Capacitor.isNativePlatform()) return { kind: 'unavailable' }
  try {
    const { supported } = await BarcodeScanner.isSupported()
    if (!supported) return { kind: 'unavailable' }
    if (Capacitor.getPlatform() === 'android') {
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
      if (!available) {
        // Play services fetch the module in the background; Scan works once it lands.
        await BarcodeScanner.installGoogleBarcodeScannerModule()
        return { kind: 'unavailable' }
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
