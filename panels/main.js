'use strict'
// Copied from cc-cockpit-github panels/main.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// The GitHub panel: lanes of rows from the host's `state` messages (panels/rowlogic.js does the sums). The page posts
// `hello` on load (a post the host made before the page was there is dropped), then `act` for a row's click
// (`open`) and its menu actions; Refresh is the header's action. Every text is a text node.

;(function () {
  const root = document.getElementById('lanes')
  const bannerEl = document.getElementById('banner')
  const noticeEl = document.getElementById('notice')
  const expanded = new Set()
  let state = null
  let menu = null
  let menuReturn = null

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = String(text)
    return e
  }

  function draw() {
    const b = ghRows.banner(state)
    bannerEl.hidden = !b
    if (b) {
      bannerEl.className = b.kind === 'loading' ? 'cc-empty' : b.kind === 'signedOut' ? 'cc-help' : 'cc-error-line'
      bannerEl.replaceChildren(el('p', null, b.text))
      if (b.hint) bannerEl.appendChild(el('p', 'cc-muted', b.hint))
      if (b.rebind) {
        // The person's click is the only thing that rebinds a token (the host checks it is still bound elsewhere).
        const btn = el('button', 'cc-button', b.rebind)
        btn.type = 'button'
        btn.addEventListener('click', () => {
          if (btn.disabled) return
          btn.disabled = true
          ccPanel.post({ type: 'rebind' })
        })
        bannerEl.appendChild(btn)
      }
    }
    const lanes = ghRows.lanesView(state, Date.now(), expanded)
    const frag = document.createDocumentFragment()
    if (state && !lanes.length) frag.appendChild(el('p', 'cc-empty', 'Every lane is off in the plugin settings.'))
    for (const lane of lanes) {
      const group = el('details', 'cc-group')
      group.open = true
      const sum = el('summary', 'cc-group-title', lane.title)
      sum.appendChild(el('span', 'cc-count', lane.total))
      group.appendChild(sum)
      if (!lane.rows.length) group.appendChild(el('p', 'cc-muted gh-none', state && state.state === 'ok' ? 'Nothing here.' : ''))
      const list = el('ul', 'cc-list')
      for (const r of lane.rows) list.appendChild(row(r))
      group.appendChild(list)
      if (lane.hidden > 0 || lane.expanded) {
        const more = el('button', 'cc-ghost gh-more', lane.expanded ? 'Show less' : `Show all (${lane.hidden} more)`)
        more.type = 'button'
        more.addEventListener('click', () => {
          if (expanded.has(lane.id)) expanded.delete(lane.id)
          else expanded.add(lane.id)
          draw()
        })
        group.appendChild(more)
      }
      frag.appendChild(group)
    }
    root.replaceChildren(frag)
  }

  function row(r) {
    const li = el('li', `cc-row${r.unread ? ' cc-unread' : ''}`)
    li.tabIndex = 0
    li.dataset.id = r.id
    li.title = r.preview || ''
    const main = el('div', 'cc-row-main')
    main.appendChild(el('span', 'cc-row-title', r.title))
    const meta = el('span', 'cc-row-meta')
    meta.appendChild(document.createTextNode(r.meta))
    for (const b of r.badges) meta.appendChild(el('span', `cc-badge ${b.color}`, b.text))
    main.appendChild(meta)
    li.appendChild(main)
    li.addEventListener('click', () => act(r.id, 'open'))
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') act(r.id, 'open')
      else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault()
        const box = li.getBoundingClientRect()
        openMenu(r, box.left + 16, box.bottom - 4, li)
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const rows = [...root.querySelectorAll('.cc-row')]
        const next = rows[rows.indexOf(li) + (ev.key === 'ArrowDown' ? 1 : -1)]
        if (next) next.focus()
      }
    })
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      openMenu(r, ev.clientX, ev.clientY, li)
    })
    return li
  }

  function act(id, action) {
    ccPanel.post({ type: 'act', id, action })
  }

  function closeMenu(focusBack) {
    if (!menu) return
    menu.remove()
    menu = null
    if (focusBack && menuReturn) menuReturn.focus()
    menuReturn = null
  }

  function openMenu(r, x, y, from) {
    closeMenu(false)
    menuReturn = from
    menu = el('div', 'cc-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', r.title)
    for (const a of r.actions) {
      const b = el('button', null, a.label)
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.addEventListener('click', () => {
        closeMenu(true)
        act(r.id, a.id)
      })
      menu.appendChild(b)
    }
    document.body.appendChild(menu)
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - h - 4))}px`
    const items = [...menu.querySelectorAll('[role=menuitem]')]
    if (items[0]) items[0].focus()
    menu.addEventListener('keydown', (ev) => {
      const i = items.indexOf(document.activeElement)
      if (ev.key === 'Escape') closeMenu(true)
      else if (ev.key === 'ArrowDown') items[(i + 1) % items.length].focus()
      else if (ev.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus()
      else if (ev.key === 'Home') items[0].focus()
      else if (ev.key === 'End') items[items.length - 1].focus()
      else return
      ev.preventDefault()
    })
    menu.addEventListener('focusout', (ev) => {
      if (menu && !menu.contains(ev.relatedTarget)) closeMenu(false)
    })
  }

  document.addEventListener('mousedown', (ev) => {
    if (menu && !menu.contains(ev.target)) closeMenu(false)
  })

  let noticeTimer
  ccPanel.onMessage((m) => {
    if (!m || typeof m !== 'object') return
    if (m.type === 'state') {
      state = m
      draw()
    } else if (m.type === 'notice' && typeof m.text === 'string') {
      noticeEl.textContent = m.text
      noticeEl.hidden = false
      clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => (noticeEl.hidden = true), 6000)
    }
  })

  // The "N min" in each row: redraw every minute.
  setInterval(() => state && draw(), 60_000)
  draw()
  ccPanel.post({ type: 'hello' })
})()
