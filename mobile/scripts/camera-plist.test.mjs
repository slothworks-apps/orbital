// The camera plugin refuses every `getPhoto` on iOS, before the camera or the
// library opens, while any usage description it lists is missing from
// Info.plist — even one for a feature Orbital does not use (adding to the
// photo library). The phone then reads only "Couldn't take that photo". This
// reads the installed plugin's list and fails on a key the app does not carry.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('Info.plist carries every usage description the camera plugin checks for', () => {
  const types = read('node_modules/@capacitor/camera/ios/Sources/CameraPlugin/CameraTypes.swift')
  const list = types.slice(types.indexOf('enum CameraPropertyListKeys'))
  const keys = [...list.slice(0, list.indexOf('var link')).matchAll(/case \w+ = "(\w+)"/g)].map((m) => m[1])
  assert.ok(keys.length > 0, 'no keys found in the plugin: its source moved')
  const plist = read('mobile/ios/App/App/Info.plist')
  for (const key of keys) assert.match(plist, new RegExp(`<key>${key}</key>`), `Info.plist lacks ${key}`)
})
