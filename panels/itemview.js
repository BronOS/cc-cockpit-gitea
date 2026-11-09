'use strict'
// Copied from cc-cockpit-github panels/itemview.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// The overlay's content from the details the host posts (dist/lib/details.js): a PR (Conversation, Checks and Files
// tabs), an issue, or a failed run. Pure DOM building against `doc`, so the tests run it under linkedom; every
// GitHub text goes in as a text node or through the sanitiser, logs and diffs as text in <pre>.
//
// Classic script in the page (global `ghItemView`), require() in tests.

;(function (root) {
  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = String(text)
    return e
  }

  function when(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed' }
  // Badge colours (the style guide's palette names) for a state.
  const TONE = { failing: 'red', conflict: 'red', failed: 'red', 'changes requested': 'amber', approved: 'green', draft: 'grey', merged: 'violet', closed: 'grey', open: 'blue' }
  const CHECK = { success: 'passed', failure: 'failed', timed_out: 'timed out', cancelled: 'cancelled', skipped: 'skipped', neutral: 'neutral', action_required: 'needs action', startup_failure: 'failed to start' }

  function body(doc, html, s) {
    const box = el(doc, 'div', 'gh-body')
    if (html) box.appendChild(s.sanitize(html, doc, s.parse))
    else box.appendChild(el(doc, 'p', 'cc-muted', 'No description.'))
    return box
  }

  function timeline(doc, events, s) {
    const list = el(doc, 'div', 'gh-timeline')
    if (!events || !events.length) {
      list.appendChild(el(doc, 'p', 'cc-muted', 'No comments yet.'))
      return list
    }
    for (const e of events) {
      const card = el(doc, 'article', `gh-event cc-card${e.state === 'CHANGES_REQUESTED' ? ' gh-changes' : e.state === 'APPROVED' ? ' gh-approved' : ''}`)
      const head = el(doc, 'header', 'gh-event-head')
      head.appendChild(el(doc, 'strong', null, e.who))
      head.appendChild(el(doc, 'span', 'cc-muted', ` ${e.kind === 'review' ? REVIEW[e.state] || 'reviewed' : 'commented'} · ${when(e.at)}`))
      card.appendChild(head)
      if (e.html) card.appendChild(s.sanitize(e.html, doc, s.parse))
      list.appendChild(card)
    }
    return list
  }

  /** Checks (PR) or jobs (run): name, state, and for a failed one its log tail. */
  function jobs(doc, rows, emptyText) {
    const box = el(doc, 'div', 'gh-checks')
    if (!rows || !rows.length) {
      box.appendChild(el(doc, 'p', 'cc-muted', emptyText))
      return box
    }
    for (const c of rows) {
      const row = el(doc, 'section', `gh-check${c.failed ? ' gh-failed' : ''}`)
      const head = el(doc, 'div', 'gh-check-head')
      head.appendChild(el(doc, 'span', 'gh-check-name', c.name))
      head.appendChild(el(doc, 'span', `cc-badge ${c.failed ? 'red' : c.conclusion === 'success' ? 'green' : 'grey'}`, CHECK[c.conclusion] || c.status || 'unknown'))
      if (c.url) {
        const a = el(doc, 'a', 'gh-link', 'details')
        a.setAttribute('href', c.url)
        head.appendChild(a)
      }
      row.appendChild(head)
      if (c.failedSteps && c.failedSteps.length) row.appendChild(el(doc, 'div', 'cc-muted', `Failed step${c.failedSteps.length > 1 ? 's' : ''}: ${c.failedSteps.join(', ')}`))
      if (c.failed && c.tail) row.appendChild(el(doc, 'pre', 'gh-log', c.tail))
      else if (c.failed && c.tailError) row.appendChild(el(doc, 'p', 'cc-muted', `Log: ${c.tailError}`))
      box.appendChild(row)
    }
    return box
  }

  function files(doc, d) {
    const box = el(doc, 'div', 'gh-files')
    if (!d.files || !d.files.length) {
      box.appendChild(el(doc, 'p', 'cc-muted', 'No changed files.'))
      return box
    }
    for (const f of d.files) {
      const det = el(doc, 'details', 'gh-file')
      const sum = el(doc, 'summary')
      sum.appendChild(el(doc, 'span', 'gh-file-name', f.name))
      sum.appendChild(el(doc, 'span', 'gh-add', ` +${f.additions}`))
      sum.appendChild(el(doc, 'span', 'gh-del', ` −${f.deletions}`))
      det.appendChild(sum)
      if (f.patch) {
        const pre = el(doc, 'pre', 'gh-diff')
        for (const line of f.patch.split('\n')) {
          const cls = line.startsWith('+') ? 'gh-diff-add' : line.startsWith('-') ? 'gh-diff-del' : line.startsWith('@@') ? 'gh-diff-hunk' : null
          pre.appendChild(el(doc, 'span', cls, `${line}\n`))
        }
        det.appendChild(pre)
      } else {
        det.appendChild(el(doc, 'p', 'cc-muted', f.tooBig ? 'Too large to show here: open the pull request on the server.' : 'No text diff (a binary file or a rename).'))
      }
      box.appendChild(det)
    }
    if (d.filesCut) box.appendChild(el(doc, 'p', 'cc-muted', `${d.filesCut} file${d.filesCut > 1 ? 's are' : ' is'} too large to show here.`))
    return box
  }

  /** Header line: repo#n, state chip, branches, author. */
  function header(doc, d) {
    const h = d.header || {}
    const box = el(doc, 'header', 'gh-head')
    box.appendChild(el(doc, 'h1', 'gh-title', d.title))
    const meta = el(doc, 'div', 'gh-meta')
    if (d.kind === 'run') {
      meta.appendChild(el(doc, 'span', 'cc-badge red', 'failed'))
      meta.appendChild(el(doc, 'span', null, `${h.workflow} · ${h.branch} · ${h.sha} · ${h.event} · run #${h.runNumber}${h.attempt > 1 ? `, attempt ${h.attempt}` : ''}`))
      if (h.commit) meta.appendChild(el(doc, 'span', 'cc-muted', h.commit))
    } else {
      const state = h.state === 'merged' || h.state === 'closed' ? h.state : h.status || h.state || 'open'
      meta.appendChild(el(doc, 'span', `cc-badge ${TONE[state] || 'grey'}`, state))
      if (d.kind === 'pr') meta.appendChild(el(doc, 'span', null, `${h.head} → ${h.base} · by ${h.author} · +${h.additions || 0} −${h.deletions || 0} in ${h.changedFiles || 0} files`))
      else meta.appendChild(el(doc, 'span', null, `by ${h.author}${h.assignees && h.assignees.length ? ` · assigned to ${h.assignees.join(', ')}` : ''}`))
    }
    box.appendChild(meta)
    return box
  }

  /**
   * The whole view. `s` is `{ sanitize, parse }`. A PR gets tabs (`data-tab` on the buttons and panes; item.js
   * switches them); the first tab is Checks when CI failed, else Conversation.
   */
  function render(doc, d, s) {
    const root = el(doc, 'div', `gh-view gh-${d.kind}`)
    root.appendChild(header(doc, d))
    if (d.kind === 'pr') {
      const failing = (d.checks || []).some((c) => c.failed)
      const tabs = el(doc, 'div', 'cc-tabs gh-tabs')
      tabs.setAttribute('role', 'tablist')
      const panes = [
        ['conversation', 'Conversation', () => {
          const p = el(doc, 'div')
          p.appendChild(body(doc, d.body, s))
          p.appendChild(timeline(doc, d.timeline, s))
          return p
        }],
        ['checks', `Checks${failing ? ' ✗' : ''}`, () => jobs(doc, d.checks, 'No checks on the head commit.')],
        ['files', `Files (${(d.files || []).length})`, () => files(doc, d)],
      ]
      const first = failing ? 'checks' : 'conversation'
      for (const [id, label] of panes) {
        const b = el(doc, 'button', null, label)
        b.setAttribute('type', 'button')
        b.setAttribute('role', 'tab')
        b.setAttribute('data-tab', id)
        b.setAttribute('aria-selected', String(id === first))
        tabs.appendChild(b)
      }
      root.appendChild(tabs)
      for (const [id, , build] of panes) {
        const pane = build()
        pane.setAttribute('data-pane', id)
        pane.setAttribute('role', 'tabpanel')
        if (id !== first) pane.hidden = true
        root.appendChild(pane)
      }
    } else if (d.kind === 'issue') {
      root.appendChild(body(doc, d.body, s))
      root.appendChild(timeline(doc, d.timeline, s))
    } else if (d.kind === 'run') {
      root.appendChild(jobs(doc, d.jobs, 'No jobs.'))
    }
    return root
  }

  const api = { render, when }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ghItemView = api
})(typeof self !== 'undefined' ? self : this)
