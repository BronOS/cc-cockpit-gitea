'use strict'
// Copied from cc-cockpit-github panels/item.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// The item overlay's page: the host posts `{ type: 'details', details }` (or `{ type: 'error', message }`), the page
// draws it (panels/itemview.js through panels/sanitize.js) and says ready. A link click asks first, in the page,
// then posts `{ open: href }`; the host opens it only when the href is one it found itself in the details.

;(function () {
  const parser = new DOMParser()
  const s = { sanitize: ghSanitize.sanitize, parse: (html) => parser.parseFromString(html, 'text/html') }
  const main = document.getElementById('main')
  const ask = document.getElementById('ask')
  const askUrl = document.getElementById('ask-url')
  let pending = null
  let readied = false

  function ready() {
    if (readied) return
    readied = true
    if (typeof ccPanel.ready === 'function') ccPanel.ready()
  }

  function show(details) {
    main.replaceChildren(ghItemView.render(document, details, s))
    ready()
  }

  function fail(message) {
    const box = document.createElement('div')
    box.className = 'cc-empty'
    const p = document.createElement('p')
    p.textContent = message || 'This item could not be loaded.'
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = 'Try again'
    b.addEventListener('click', () => {
      main.replaceChildren()
      ccPanel.post({ type: 'retry' })
    })
    box.append(p, b)
    main.replaceChildren(box)
    ready()
  }

  ccPanel.onMessage((m) => {
    if (!m || typeof m !== 'object') return
    if (m.type === 'details' && m.details) show(m.details)
    else if (m.type === 'error') fail(m.message)
  })

  // Tabs (a PR): switch panes; arrows move between tabs.
  main.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-tab]')
    if (tab) {
      for (const b of main.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === tab))
      for (const p of main.querySelectorAll('[data-pane]')) p.hidden = p.getAttribute('data-pane') !== tab.getAttribute('data-tab')
      return
    }
    const a = ev.target.closest('a[href]')
    if (!a) return
    ev.preventDefault()
    pending = a.getAttribute('href')
    askUrl.textContent = pending
    ask.hidden = false
    document.getElementById('ask-open').focus()
  })
  main.addEventListener('keydown', (ev) => {
    const tab = ev.target.closest && ev.target.closest('[data-tab]')
    if (!tab || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return
    const tabs = [...main.querySelectorAll('[data-tab]')]
    const i = tabs.indexOf(tab) + (ev.key === 'ArrowRight' ? 1 : -1)
    const next = tabs[(i + tabs.length) % tabs.length]
    next.focus()
    next.click()
  })

  document.getElementById('ask-open').addEventListener('click', () => {
    if (pending) ccPanel.post({ open: pending })
    pending = null
    ask.hidden = true
  })
  document.getElementById('ask-cancel').addEventListener('click', () => {
    pending = null
    ask.hidden = true
  })
})()
