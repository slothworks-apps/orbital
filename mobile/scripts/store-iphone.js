/* global document */
// Injected into the phone UI before each App Store screenshot (store-driver.mjs):
// iPhone 17 Pro Max safe areas in place of env(), which a desktop WebKit
// leaves at 0, and a 9:41 status bar.
;(() => {
  const inset = { top: '62px', bottom: '34px', left: '0px', right: '0px' }
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
    'position:fixed;top:0;left:0;right:0;height:62px;z-index:2147483647;pointer-events:none;display:flex;align-items:center;justify-content:space-between;padding:6px 38px 0 52px;color:#fff;font:600 17px -apple-system,system-ui,sans-serif;letter-spacing:-0.2px'
  bar.innerHTML = `<span>9:41</span><span style="display:flex;gap:7px;align-items:center">
<svg width="19" height="12" viewBox="0 0 19 12" fill="#fff"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5.2" y="5.5" width="3.2" height="6.5" rx="1"/><rect x="10.4" y="3" width="3.2" height="9" rx="1"/><rect x="15.6" y="0" width="3.2" height="12" rx="1"/></svg>
<svg width="17" height="12" viewBox="0 0 17 12" fill="#fff"><path d="M8.5 2.3c2.4 0 4.6.9 6.3 2.5l1.2-1.2C14 1.6 11.4.6 8.5.6S3 1.6 1 3.6l1.2 1.2C3.9 3.2 6.1 2.3 8.5 2.3z"/><path d="M8.5 5.6c1.5 0 2.9.6 3.9 1.5l1.2-1.2c-1.4-1.3-3.2-2-5.1-2s-3.7.7-5.1 2l1.2 1.2c1-.9 2.4-1.5 3.9-1.5z"/><path d="M8.5 8.9c.6 0 1.2.2 1.6.6L8.5 11.2 6.9 9.5c.4-.4 1-.6 1.6-.6z"/></svg>
<svg width="28" height="13" viewBox="0 0 28 13"><rect x=".5" y=".5" width="24" height="12" rx="3.8" fill="none" stroke="#fff" stroke-opacity=".4"/><rect x="2" y="2" width="21" height="9" rx="2.5" fill="#fff"/><path d="M26 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="#fff" fill-opacity=".4"/></svg></span>`
  document.body.appendChild(bar)
})()
