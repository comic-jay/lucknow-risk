#!/usr/bin/env node
/*
 * rebuild_dashboard.js  —  run me after every data update.
 *
 *     node rebuild_dashboard.js
 *
 * WHY THIS EXISTS
 * ---------------
 * Every card on the dashboard used to be built in the browser by render().
 * iOS Quick Look — the preview you get when you tap an .html in Files, or
 * open one straight from Mail — displays HTML but never runs JavaScript.
 * So on a phone or iPad the page showed headings and takeaways and nothing
 * else. Desktop browsers were fine, which is why it went unnoticed.
 *
 * The fix is to bake the rendered markup into the file. This script does
 * that WITHOUT duplicating any logic: it executes the page's own <script>
 * against a minimal DOM stub, then writes whatever render() produced back
 * into the matching containers, between <!--auto--> markers.
 *
 * So the workflow stays: edit METRICS / AS_OF / takeaways in the HTML as
 * before, then run this script. Thresholds, weights and ladder logic are
 * read from the file, never restated here — if they change, this follows.
 *
 * Re-running is safe: previous output is stripped first.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] ||
  path.join(__dirname, 'North_India_Risk_Dashboard.html');

const START = '<!--auto:start-->';
const END = '<!--auto:end-->';

/* ------------------------------------------------------------------ *
 * 1. A DOM stub with just the handful of things render() touches.
 * ------------------------------------------------------------------ */

function makeEl(tag) {
  return {
    tagName: tag,
    className: '',
    _text: null,
    innerHTML: '',
    children: [],
    style: {},
    appendChild(c) { this.children.push(c); return c; },
    set textContent(v) { this._text = v; this.children = []; this.innerHTML = ''; },
    get textContent() { return this._text; }
  };
}

const IDS = ['verdict', 'verdictDesc', 'meter', 'actionbar', 'ladder',
  'grid-water', 'grid-air', 'grid-food', 'grid-energy', 'grid-money', 'grid-ctx'];

const els = {};
IDS.forEach(id => { els[id] = makeEl('div'); });

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const styleAttr = st => {
  const pairs = Object.entries(st).filter(([, v]) => v !== undefined && v !== '');
  if (!pairs.length) return '';
  const kebab = k => k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  return ' style="' + pairs.map(([k, v]) => `${kebab(k)}:${v}`).join(';') + '"';
};

// Serialise an element's *contents* (not its own tag).
function inner(el) {
  if (el._text !== null) return esc(el._text);
  if (el.children.length) {
    return el.children.map(c =>
      `<div class="${c.className}"${styleAttr(c.style)}>${inner(c)}</div>`
    ).join('\n');
  }
  return el.innerHTML;
}

const sandbox = {
  document: {
    getElementById: id => els[id] || null,
    createElement: makeEl
  },
  // Quick Look has no storage either; render() already guards these.
  localStorage: { getItem: () => null, setItem: () => {} },
  console
};

/* ------------------------------------------------------------------ *
 * 2. Run the page's own script.
 * ------------------------------------------------------------------ */

let html = fs.readFileSync(FILE, 'utf8');

const sOpen = html.lastIndexOf('<script>');
const sClose = html.lastIndexOf('</script>');
if (sOpen === -1 || sClose === -1) {
  console.error('Could not find the <script> block. Aborting, file untouched.');
  process.exit(1);
}
const pageScript = html.slice(sOpen + '<script>'.length, sClose);

try {
  new Function('document', 'localStorage', 'console', pageScript)(
    sandbox.document, sandbox.localStorage, sandbox.console
  );
} catch (e) {
  console.error('The page script threw while pre-rendering:', e.message);
  console.error('File left untouched.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3. Write the rendered markup back in.
 * ------------------------------------------------------------------ */

// Drop any markup a previous run injected, so this is idempotent.
html = html.replace(
  new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' +
    END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
  ''
);

let injected = 0;

function fill(id, content, extraStyle) {
  // Locate this element's opening tag and rebuild it.
  const re = new RegExp('<div([^>]*?)id="' + id + '"([^>]*?)>');
  const m = re.exec(html);
  if (!m) { console.warn('  ! no container for #' + id); return; }

  let attrs = (m[1] + m[2]);
  attrs = attrs.replace(/\s*style="[^"]*"/g, '');           // drop our old inline style
  const style = extraStyle ? ` style="${extraStyle}"` : '';
  const open = `<div${attrs.replace(/\s+$/, '')} id="${id}"${style}>`;

  // Everything between the opening tag and its matching close is replaced.
  const from = m.index;
  const afterOpen = m.index + m[0].length;
  const close = findClose(html, afterOpen);
  if (close === -1) { console.warn('  ! unbalanced div for #' + id); return; }

  html = html.slice(0, from) + open + START + '\n' + content + '\n' + END +
    html.slice(close);
  injected++;
}

// Walk forward counting nested <div>s to find this element's own </div>.
function findClose(s, from) {
  let depth = 1, i = from;
  const re = /<\/?div\b/gi;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].toLowerCase() === '<div') depth++;
    else if (--depth === 0) return m.index;
    i = re.lastIndex;
  }
  return -1;
}

const v = els.verdict;
fill('verdict', `<span style="color:${v.style.color || 'inherit'}">${esc(v.textContent || '')}</span>`);
fill('verdictDesc', esc(els.verdictDesc.textContent || ''));
fill('meter', inner(els.meter));

const ab = els.actionbar;
fill('actionbar', inner(ab),
  `background:${ab.style.background};border-color:${ab.style.borderColor}`);

fill('ladder', inner(els.ladder));
['water', 'air', 'food', 'energy', 'money', 'ctx']
  .forEach(k => fill('grid-' + k, inner(els['grid-' + k])));

fs.writeFileSync(FILE, html);
console.log(`Pre-rendered ${injected} containers into ${path.basename(FILE)}`);
console.log('Verdict :', els.verdict.textContent);
console.log('Strain  :', (inner(els.meter).match(/>(\d+)</) || [])[1], '/ 100');
console.log('Level   :', (inner(els.actionbar).match(/<b>(L\d)<\/b>/) || [])[1]);
