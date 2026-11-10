'use strict'
// Copied from cc-cockpit-github panels/rowlogic.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// The panel's pure part: the host's state message into lanes of rows with their meta line and badges. No DOM, so it
// is tested under node; main.js draws what this returns. Classic script in the page (global `ghRows`).

;(function (root) {
  const LANES = [
    ['reviewRequested', 'Review requested'],
    ['myPrs', 'My pull requests'],
    ['issues', 'Issues'],
    ['failedRuns', 'Failed runs'],
  ]

  // Label → badge (text, palette colour), in the order they show.
  const BADGES = [
    ['ci:failed', 'CI failed', 'red'],
    ['conflict', 'conflict', 'red'],
    ['changes-requested', 'changes', 'amber'],
    ['approved', 'approved', 'green'],
    ['ci:pending', 'CI running', 'grey'],
    ['draft', 'draft', 'grey'],
    ['team-review-requested', 'team', 'violet'],
    ['mentioned', 'mentioned', 'blue'],
    ['my-issue', 'mine', 'grey'],
  ]

  /** `just now`, `5 min`, `3 h`, `2 d`, or a date past two weeks. */
  function ago(ms, now) {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const s = Math.max(0, Math.round((now - ms) / 1000))
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)} min`
    if (s < 86400) return `${Math.round(s / 3600)} h`
    if (s < 14 * 86400) return `${Math.round(s / 86400)} d`
    return new Date(ms).toISOString().slice(0, 10)
  }

  function badgesOf(labels) {
    const set = new Set(labels || [])
    return BADGES.filter(([l]) => set.has(l)).map(([, text, color]) => ({ text, color }))
  }

  /**
   * Lanes to draw: `[{ id, title, rows, total, hidden }]` for the enabled lanes, newest first. `open` is the set of
   * lane ids the person expanded (Show all). A row in two PR lanes shows in both.
   */
  function lanesView(state, now, open) {
    if (!state || !state.lanes) return []
    const per = Number.isInteger(state.rowsPerLane) ? state.rowsPerLane : 10
    const out = []
    for (const [id, title] of LANES) {
      if (!state.lanes[id]) continue
      const all = (state.rows || []).filter((r) => Array.isArray(r.lanes) && r.lanes.includes(id)).sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1))
      const expanded = open && open.has(id)
      const rows = (expanded ? all : all.slice(0, per)).map((r) => ({
        id: r.id,
        title: r.title,
        meta: [r.repo, r.from && r.from !== '' ? r.from : null, ago(r.time, now)].filter(Boolean).join(' · '),
        preview: r.preview,
        unread: r.read === false,
        badges: badgesOf(r.labels),
        actions: r.actions || [],
      }))
      out.push({ id, title, rows, total: all.length, hidden: all.length - rows.length, expanded: Boolean(expanded) })
    }
    return out
  }

  /**
   * What the panel says instead of (or above) the lanes: null when the lanes say enough. Signed out (Gitea): the
   * host's `reason` decides the help. A missing or refused address or token points at Settings (the app's gear in
   * the panel header; a panel draws no settings of its own); a token bound to another server offers `rebind`, the
   * person's own click to use it here.
   */
  function banner(state) {
    if (!state) return { kind: 'loading', text: 'Loading…' }
    if (state.state === 'signedOut') {
      const b = { kind: 'signedOut', text: state.message || 'Not signed in. Set the server address and an access token in Settings, then Refresh.' }
      if (state.reason === 'bound' && state.boundTo && state.server) b.rebind = `Use this token for ${state.server}`
      else b.hint = 'The gear in this panel’s header opens Settings.'
      return b
    }
    if (state.state === 'error' && state.message) return { kind: 'error', text: state.message }
    return null
  }

  const api = { lanesView, banner, badgesOf, ago, LANES }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ghRows = api
})(typeof self !== 'undefined' ? self : this)
