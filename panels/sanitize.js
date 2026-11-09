'use strict'
// Copied from cc-cockpit-github panels/sanitize.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// GitHub's rendered HTML (a PR description, a comment) into nodes this page can show. GitHub sanitises its own
// rendering, but here it is untrusted input all the same: it is parsed inert (DOMParser, no script runs, nothing
// loads) and rebuilt element by element from an allow-list into a fresh fragment, so nothing the list does not
// name survives: no script, no style, no event attribute, no form, no iframe, no remote image (an image becomes a
// link), no id or class. A link keeps its href only when it is http(s); the host opens a link only when it is one
// the host itself found in the same HTML (panels/item.js posts it back, dist/lib/overlay.js checks).
//
// The page's CSP (no inline script, no network) is the backstop, not the defence.
//
// Loaded as a classic script in the page (global `ghSanitize`) and with require() in tests (linkedom's DOM).

;(function (root) {
  const KEEP = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'strong', 'em', 'b', 'i', 's', 'del', 'ins',
    'sub', 'sup', 'span', 'div', 'details', 'summary', 'kbd', 'dl', 'dt', 'dd', 'mark', 'q', 'abbr',
  ])
  // Dropped with everything inside: their content is not text a person should read here.
  const DROP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'select', 'textarea', 'button', 'head', 'title', 'meta', 'link', 'base', 'frame', 'frameset', 'video', 'audio', 'source', 'track', 'canvas'])
  const MAX_DEPTH = 64
  const MAX_NODES = 20000

  /** An http(s) address as the URL parser writes it, or null. */
  function safeHref(href) {
    if (typeof href !== 'string' || !href.trim()) return null
    try {
      const u = new URL(href.trim())
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
    } catch {
      return null
    }
  }

  /**
   * A DocumentFragment of `doc` holding the allowed content of `html`. `parse(html)` returns a parsed Document
   * (DOMParser in the page; linkedom in tests).
   */
  function sanitize(html, doc, parse) {
    const out = doc.createDocumentFragment()
    if (typeof html !== 'string' || !html) return out
    const parsed = parse(html)
    const body = parsed.body || parsed.documentElement
    let budget = MAX_NODES
    function copy(from, to, depth) {
      for (const n of Array.from(from.childNodes)) {
        if (--budget < 0) return
        if (n.nodeType === 3) {
          to.appendChild(doc.createTextNode(n.nodeValue))
          continue
        }
        if (n.nodeType !== 1) continue
        const tag = n.tagName.toLowerCase()
        if (DROP.has(tag)) continue
        if (depth >= MAX_DEPTH) {
          to.appendChild(doc.createTextNode(n.textContent || ''))
          continue
        }
        if (tag === 'img') {
          const src = safeHref(n.getAttribute('src'))
          const alt = (n.getAttribute('alt') || '').trim()
          if (src) {
            const a = doc.createElement('a')
            a.setAttribute('href', src)
            a.textContent = `[image${alt ? `: ${alt}` : ''}]`
            to.appendChild(a)
          } else if (alt) to.appendChild(doc.createTextNode(`[image: ${alt}]`))
          continue
        }
        if (tag === 'input') {
          // Task list check boxes: as text, never a control.
          if ((n.getAttribute('type') || '').toLowerCase() === 'checkbox') to.appendChild(doc.createTextNode(n.hasAttribute('checked') ? '☑ ' : '☐ '))
          continue
        }
        if (!KEEP.has(tag)) {
          // Unknown wrapper (g-emoji, picture, a custom element): keep its text and allowed children.
          copy(n, to, depth + 1)
          continue
        }
        const el = doc.createElement(tag)
        if (tag === 'a') {
          const href = safeHref(n.getAttribute('href'))
          if (href) el.setAttribute('href', href)
        }
        if ((tag === 'td' || tag === 'th') && /^(left|right|center)$/.test(n.getAttribute('align') || '')) el.setAttribute('align', n.getAttribute('align'))
        copy(n, el, depth + 1)
        to.appendChild(el)
      }
    }
    copy(body, out, 0)
    return out
  }

  /** Every http(s) href the sanitised HTML would keep, as the page writes it (the host's own list does the same). */
  function hrefsOf(html, parse) {
    const out = []
    if (typeof html !== 'string' || !html) return out
    const parsed = parse(html)
    for (const a of Array.from(parsed.querySelectorAll('a[href], img[src]'))) {
      const h = safeHref(a.getAttribute(a.tagName.toLowerCase() === 'img' ? 'src' : 'href'))
      if (h) out.push(h)
    }
    return out
  }

  const api = { sanitize, safeHref, hrefsOf, KEEP, DROP }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ghSanitize = api
})(typeof self !== 'undefined' ? self : this)
