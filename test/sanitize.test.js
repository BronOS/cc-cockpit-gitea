'use strict'
// Copied from cc-cockpit-github test/sanitize.test.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// The sanitiser under a real HTML parser (linkedom, a dev dependency only): hostile input of the kinds that get
// past naive filters.
const test = require('node:test')
const assert = require('node:assert/strict')
const { DOMParser, parseHTML } = require('linkedom')
const { sanitize, hrefsOf, safeHref } = require('../panels/sanitize')

const { document } = parseHTML('<!doctype html><html><body></body></html>')
const parse = (html) => new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')

function clean(html) {
  const box = document.createElement('div')
  box.appendChild(sanitize(html, document, parse))
  return box.innerHTML
}

test('keeps the ordinary GitHub markup', () => {
  assert.equal(clean('<p>Fix <strong>login</strong> and <code>x()</code></p>'), '<p>Fix <strong>login</strong> and <code>x()</code></p>')
  assert.equal(clean('<ul><li>a</li></ul><pre><code>b</code></pre><blockquote>c</blockquote>'), '<ul><li>a</li></ul><pre><code>b</code></pre><blockquote>c</blockquote>')
  assert.equal(clean('<table><tr><td align="right">1</td><td align="x">2</td></tr></table>'), '<table><tr><td align="right">1</td><td>2</td></tr></table>')
})

test('scripts, styles, frames, forms and svg are dropped with their content', () => {
  for (const bad of [
    '<script>alert(1)</script>',
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload="alert(1)"><circle/></svg>',
    '<form action="https://evil.example"><input name="x"><button>go</button></form>',
    '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
    '<template><img src=x onerror=alert(1)></template>',
    '<object data="x"></object><embed src="x">',
  ]) {
    const out = clean(`${bad}<p>ok</p>`)
    assert.equal(out, '<p>ok</p>', bad)
  }
})

test('no attribute survives but a safe href and a table align', () => {
  const out = clean('<p id="x" class="y" style="color:red" onclick="alert(1)" data-x="1">t</p><a href="https://github.com/acme" onmouseover="x" target="_blank" rel="x">l</a>')
  assert.equal(out, '<p>t</p><a href="https://github.com/acme">l</a>')
})

test('links: http(s) only; javascript:, data:, vbscript: and relative hrefs dropped', () => {
  assert.equal(clean('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(clean('<a href=" JaVaScRiPt:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(clean('<a href="data:text/html,<script>alert(1)</script>">x</a>'), '<a>x</a>')
  assert.equal(clean('<a href="vbscript:x">x</a>'), '<a>x</a>')
  assert.equal(clean('<a href="/acme/widgets">x</a>'), '<a>x</a>')
  const box = document.createElement('div')
  box.appendChild(sanitize('<a href="https://github.com/a?b=1&amp;c=2">x</a>', document, parse))
  assert.equal(box.querySelector('a').getAttribute('href'), 'https://github.com/a?b=1&c=2')
})

test('images never load: a link to them instead, or their alt text', () => {
  assert.equal(clean('<img src="https://user-images.githubusercontent.com/1.png" alt="shot">'), '<a href="https://user-images.githubusercontent.com/1.png">[image: shot]</a>')
  assert.equal(clean('<img src=x onerror=alert(1) alt="a">'), '[image: a]')
  assert.equal(clean('<img src="data:image/png;base64,AAAA">'), '')
})

test('task list boxes become text; unknown wrappers keep their text', () => {
  assert.equal(clean('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>'), '<ul><li>☑  done</li><li>☐  todo</li></ul>')
  assert.equal(clean('<g-emoji alias="tada">🎉</g-emoji> <picture><source srcset="x"><b>hi</b></picture>'), '🎉 <b>hi</b>')
})

test('mXSS-style nesting and deep trees stay inert', () => {
  const out = clean('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript><p>after</p>')
  assert.ok(!/onerror|<img/i.test(out), out)
  const deep = '<div>'.repeat(200) + 'x' + '</div>'.repeat(200)
  const d = clean(deep)
  assert.ok(d.includes('x'))
  assert.ok((d.match(/<div>/g) || []).length <= 64)
})

test('text is text: markup-looking text stays escaped', () => {
  assert.equal(clean('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
})

test('hrefsOf lists what the page keeps; safeHref normalises', () => {
  assert.deepEqual(hrefsOf('<a href="https://github.com/x">a</a><a href="javascript:x">b</a><img src="https://img.example/1.png">', parse), ['https://github.com/x', 'https://img.example/1.png'])
  assert.equal(safeHref('HTTPS://GitHub.com/x'), 'https://github.com/x')
  assert.equal(safeHref('ftp://x'), null)
})
