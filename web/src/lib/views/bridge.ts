import { VIEW_SEND_MAX_CHARS } from '@orbital/shared/views'

/**
 * The `orbital` object a view's page talks to Orbital through (spec
 * 2026-11-18-generated-views-design § The bridge), as the script injected
 * into the page ahead of its content. The frame is sandboxed without
 * `allow-same-origin`, so `postMessage` is the only way out; the parent reads
 * what comes back through `protocol.ts`, which trusts none of it.
 *
 * Inside the page:
 *
 * - `orbital.data` — the view's data: JSON parsed, a CSV as its text, null for none;
 * - `orbital.onTheme(fn)` — called with the new variables when the colour theme changes;
 * - `orbital.send(value)` — sends a JSON value back, only inside a user
 *   gesture; returns whether it went.
 *
 * Besides, unasked: the content's height (for the footer that says how much
 * scrolls inside), uncaught errors and scripts that did not load (the
 * failure state), a press on a link (opened in the user's browser, never in
 * the frame), Escape (closes the maximised viewer), and `ready` once the page
 * has drawn.
 *
 * Every message carries `MESSAGE_TAG`, so the parent can tell the bridge's
 * own messages from anything else a page posts.
 */
export const MESSAGE_TAG = 'orbital-view'

/** The id of the `<script type="application/json">` the data rides in. */
export const DATA_ELEMENT_ID = 'orbital-data'

/**
 * The script itself. Plain ES5-ish JavaScript in a string: it runs in the
 * page, never in Orbital, and must not depend on the page's own code having
 * run (or having failed).
 */
export const BRIDGE_SOURCE = `(function () {
  var TAG = ${JSON.stringify(MESSAGE_TAG)};
  var MAX = ${VIEW_SEND_MAX_CHARS};
  var post = function (message) {
    message.tag = TAG;
    try { parent.postMessage(message, '*'); } catch (e) {}
  };
  var data = null;
  try {
    var el = document.getElementById(${JSON.stringify(DATA_ELEMENT_ID)});
    if (el) data = JSON.parse(el.textContent || 'null');
  } catch (e) {}
  var themeListeners = [];
  var reported = false;
  var report = function (kind, message, url) {
    if (reported) return;
    reported = true;
    post({ type: 'error', kind: kind, message: String(message || 'Unknown error').slice(0, 2000), url: url || undefined });
  };
  var activation = function () {
    var ua = navigator.userActivation;
    return !ua || ua.isActive;
  };
  window.orbital = Object.freeze({
    data: data,
    onTheme: function (fn) {
      if (typeof fn === 'function') themeListeners.push(fn);
    },
    send: function (value) {
      if (!activation()) return false;
      var text;
      try { text = JSON.stringify(value === undefined ? null : value); } catch (e) { return false; }
      if (typeof text !== 'string' || text.length > MAX) return false;
      post({ type: 'send', value: JSON.parse(text) });
      return true;
    },
    __ready: function () { post({ type: 'ready' }); },
    __fail: function (kind, message, url) { report(kind, message, url); }
  });

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || m.tag !== TAG || m.type !== 'theme' || !m.vars) return;
    var root = document.documentElement;
    for (var name in m.vars) {
      if (/^--[a-z0-9-]+$/.test(name)) root.style.setProperty(name, String(m.vars[name]));
    }
    for (var i = 0; i < themeListeners.length; i++) {
      try { themeListeners[i](m.vars); } catch (e) {}
    }
  });

  var IMPORT_FAILED = /(?:Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)[:.]?\\s*(\\S+)?/;
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      report('script', 'did not load', target.src || target.href);
      return;
    }
    var message = event.message || (event.error && event.error.message) || 'Script error';
    var file = event.filename ? String(event.filename) : '';
    // The component runs from a data: URL, which names nothing worth reading.
    file = /^data:/.test(file) ? 'view.js' : file.split('/').pop();
    var where = file ? ' (' + file + ':' + event.lineno + ')' : '';
    report('page', message + where);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    var failed = IMPORT_FAILED.exec(message);
    if (failed) report('script', 'did not load', failed[1]);
    else report('page', message);
  });

  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node.nodeType === 1 && node.tagName !== 'A') node = node.parentNode;
    if (!node || node.nodeType !== 1 || !node.getAttribute('href')) return;
    var href = node.href;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) post({ type: 'open', url: href });
  }, true);
  window.open = function (url) {
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) post({ type: 'open', url: url });
    return null;
  };

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !event.defaultPrevented) post({ type: 'escape' });
  });

  var lastHeight = -1;
  var measure = function () {
    var root = document.documentElement;
    var body = document.body;
    var height = Math.max(root.scrollHeight, body ? body.scrollHeight : 0);
    if (height !== lastHeight) {
      lastHeight = height;
      post({ type: 'height', height: height });
    }
  };
  var watch = function () {
    measure();
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();`
