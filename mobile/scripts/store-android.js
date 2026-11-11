/* global document */
// Injected into the phone UI before each Google Play screenshot
// (store-driver.mjs --android): an Android phone's edge-to-edge insets in
// place of env(), which a desktop Chromium leaves at 0, a status bar with the
// clock on the left, and the gesture navigation handle.
;(() => {
  const inset = { top: '36px', bottom: '20px', left: '0px', right: '0px' }
  const swap = (v) => v.replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,[^)]*)?\)/g, (_, k) => inset[k])
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules) walk(r.cssRules)
      // cssText, not per property: a shorthand holding env() leaves its longhands empty.
      if (r.style && r.style.cssText.includes('safe-area-inset')) r.style.cssText = swap(r.style.cssText)
    }
  }
  for (const s of document.styleSheets) {
    try { walk(s.cssRules) } catch { /* a cross-origin sheet hides its rules */ }
  }
  for (const el of document.querySelectorAll('[style*="safe-area-inset"]')) el.setAttribute('style', swap(el.getAttribute('style')))
  if (document.getElementById('fake-status')) return
  const bar = document.createElement('div')
  bar.id = 'fake-status'
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:36px;z-index:2147483647;pointer-events:none;display:flex;align-items:center;justify-content:space-between;padding:2px 22px 0 26px;color:#fff;font:500 14px Roboto,system-ui,sans-serif;letter-spacing:.1px'
  bar.innerHTML = `<span>10:00</span><span style="display:flex;gap:6px;align-items:center">
<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M12 21 1 8.5C4 6 7.8 4.5 12 4.5S20 6 23 8.5z"/></svg>
<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M2 22 22 2v20z"/></svg>
<svg width="9" height="16" viewBox="0 0 9 16"><rect x="2.5" y="0" width="4" height="2" rx=".6" fill="#fff"/><rect x="0" y="1.5" width="9" height="14.5" rx="1.6" fill="#fff"/></svg></span>`
  document.body.appendChild(bar)
  const handle = document.createElement('div')
  handle.style.cssText =
    'position:fixed;bottom:8px;left:50%;width:108px;height:4px;margin-left:-54px;border-radius:2px;background:rgba(255,255,255,.8);z-index:2147483647;pointer-events:none'
  document.body.appendChild(handle)
})()
