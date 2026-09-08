import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInContext } from 'node:vm'

import { PAGE_HELPERS, callHelper } from '../src/browser-page.js'

/**
 * The page helpers, run in a page.
 *
 * `browser_read_page`, `browser_fill` and every ref an agent aims a click at
 * come out of this script, and until now nothing ran it outside a live
 * browser. jsdom is close enough for what these helpers read — names, roles,
 * values, the ref table — and has no layout, so the two things a real page
 * supplies are stubbed: every element has a box, and `scrollIntoView` exists.
 */

// jsdom ships no declaration file; `require` keeps the test typed without one.
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: Record<string, unknown>) => { getInternalVMContext(): object } }

const page = (body: string) => {
  const dom = new JSDOM(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    url: 'http://fixture.test/',
    runScripts: 'outside-only',
  })
  const context = dom.getInternalVMContext()
  runInContext(
    `Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20 } };
     Element.prototype.scrollIntoView = function () {};
     Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent } });`,
    context,
  )
  const helper = (call: string): unknown => {
    const raw = runInContext(callHelper(call), context) as unknown
    if (typeof raw !== 'string') return raw
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }
  return { context, helper }
}

test('a control wrapped in its label is named by the label’s own words, not by its options', () => {
  const { helper } = page(`
    <form>
      <label>Email address <input id="email" placeholder="you@example.com"></label>
      <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
      <label><input type="checkbox" id="agree"> I agree</label>
      <button type="submit">Sign in</button>
    </form>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox "Email address" \[ref_1\] value=""/)
  assert.match(tree, /- combobox "Plan" \[ref_2\] value="free"/, 'the options are the value, not the name')
  assert.match(tree, /- checkbox "I agree" \[ref_3\] unchecked/)
  assert.match(tree, /- button "Sign in" \[ref_4\]/)
  assert.doesNotMatch(tree, /FreePro/)
})

test('a label that points at its control by id, and a labelledby, both leave the control’s own text out', () => {
  const { helper } = page(`
    <label for="size">Size <select id="size"><option>Small</option><option>Large</option></select></label>
    <span id="hint">Colour <select id="colour" aria-labelledby="hint"><option>Red</option></select></span>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- combobox "Size" \[ref_1\]/)
  assert.match(tree, /- combobox "Colour" \[ref_2\]/)
})

test('a label built from several elements keeps the spaces between its words', () => {
  const { helper } = page(`
    <label><span>First</span><span>name</span> <input id="first"></label>
    <label><strong>Important:</strong><span>Username</span> <input id="user"></label>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox "First name" \[ref_1\]/)
  assert.match(tree, /- textbox "Important: Username" \[ref_2\]/)
})

test('fill chooses a select option by value or by its visible text, and says what it did', () => {
  const { helper } = page(`<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>`)
  helper('__hd.tree({})')
  assert.deepEqual(helper('__hd.fill("ref_1", "pro")'), { role: 'combobox', name: 'Plan', value: 'pro' })
  assert.deepEqual(helper('__hd.fill("ref_1", "Free")'), { role: 'combobox', name: 'Plan', value: 'free' })
  assert.throws(() => helper('__hd.fill("ref_1", "enterprise")'), /No option matches "enterprise"/)
})

test('a ref is the page’s own, and a stale or made-up one fails by name', () => {
  const { helper, context } = page(`<button id="go">Go</button>`)
  helper('__hd.tree({})')
  assert.throws(() => helper('__hd.rect("nope")'), /looks like ref_3/)
  assert.throws(() => helper('__hd.rect("ref_9")'), /not a reference this page handed out/)
  runInContext(`document.getElementById('go').remove()`, context)
  assert.throws(() => helper('__hd.rect("ref_1")'), /since removed/)
})

test('a link that wraps onto two lines is aimed at a line box, not the gap between them', () => {
  const { helper, context } = page(`<p>Some words <a id="wrapped" href="/x">a link at the end of the line that wraps</a></p>`)
  helper('__hd.tree({})')
  // Two line boxes; the bounding box's centre falls on the paragraph between them.
  runInContext(
    `document.getElementById('wrapped').getClientRects = () => [
       { left: 200, top: 100, width: 150, height: 20, right: 350, bottom: 120, x: 200, y: 100 },
       { left: 20, top: 124, width: 90, height: 20, right: 110, bottom: 144, x: 20, y: 124 },
     ];
     document.getElementById('wrapped').getBoundingClientRect = () => ({ left: 20, top: 100, width: 330, height: 44, right: 350, bottom: 144, x: 20, y: 100 })`,
    context,
  )
  const box = helper('__hd.rect("ref_1")') as { x: number; y: number }
  assert.deepEqual([box.x, box.y], [275, 110], 'the centre of the largest line box')
})

test('a query keeps the document line and only the lines that match', () => {
  const { helper } = page(`<h1>Welcome</h1><a href="/docs">Read the docs</a><button>Sign in</button>`)
  const narrowed = String(helper('__hd.tree({ query: "docs" })'))
  assert.match(narrowed, /^- document "Fixture"/)
  assert.match(narrowed, /link "Read the docs" \[ref_1\] href="\/docs"/)
  assert.doesNotMatch(narrowed, /Sign in/)
  assert.match(String(helper('__hd.tree({ query: "zzz" })')), /nothing on this page matches "zzz"/)
})

test('a password never leaves the page — the tree says a field is secret, not what is in it', () => {
  const { helper } = page(`
    <form>
      <label>Email <input id="email" value="ada@example.com"></label>
      <label>Password <input id="pw" type="password" value="hunter2-correct-horse"></label>
      <label>Confirm <input id="new" type="password"></label>
      <label>Code <input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code" value="418922"></label>
      <label>Card <input id="cc" autocomplete="section-blue billing new-password" value="s3cr3t"></label>
      <label>Search <input id="q" type="search" value="visible query"></label>
    </form>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox "Password" \[ref_2\] secret filled/)
  assert.match(tree, /- textbox "Confirm" \[ref_3\] secret empty/, 'whether a field is filled is what the dots already say')
  assert.match(tree, /- textbox "Code" \[ref_4\] secret filled/, 'a one-time code declares itself with autocomplete, not with type')
  assert.match(tree, /- textbox "Card" \[ref_5\] secret filled/, 'autocomplete is a token list, matched per token')
  // The ordinary fields are untouched — this redacts secrets, not values.
  assert.match(tree, /- textbox "Email" \[ref_1\] value="ada@example.com"/)
  assert.match(tree, /- searchbox "Search" \[ref_6\] value="visible query"/)
  for (const secret of ['hunter2-correct-horse', '418922', 's3cr3t']) {
    assert.doesNotMatch(tree, new RegExp(secret), `${secret} reached the model’s context`)
  }
  // Nor by the back door: a query filters the lines, and the value is not in one.
  assert.match(String(helper('__hd.tree({ query: "hunter2" })')), /nothing on this page matches/)
  assert.doesNotMatch(String(helper('__hd.tree({ filter: "all" })')), /hunter2/)
  assert.doesNotMatch(String(helper('__hd.text({})')), /hunter2/)
})

test('filling a password still writes it, and says so without saying it', () => {
  const { helper, context } = page(`
    <label>Password <input id="pw" type="password"></label>
    <label>Nickname <input id="nick"></label>`)
  helper('__hd.tree({})')
  assert.deepEqual(
    helper('__hd.fill("ref_1", "correct-horse-battery-staple")'),
    { role: 'textbox', name: 'Password', secret: true, filled: true },
    'browser_fill hands its return value to the model verbatim',
  )
  // The point of the redaction is the read-back. The write is the sign-in.
  assert.equal(runInContext(`document.getElementById('pw').value`, context), 'correct-horse-battery-staple')
  assert.deepEqual(helper('__hd.fill("ref_1", "")'), { role: 'textbox', name: 'Password', secret: true, filled: false })
  assert.deepEqual(helper('__hd.fill("ref_2", "ada")'), { role: 'textbox', name: 'Nickname', value: 'ada' })
})

test('a secret field with no label is nameless rather than named after its own contents', () => {
  // Found by review: redacting the value bit while handing the same characters
  // over as the *name* is not a redaction — and name() is not only the tree,
  // rect() returns it and rect() is on the path of every click.
  const { helper } = page(`
    <textarea id="key" autocomplete="current-password">-----BEGIN KEY----- leaked</textarea>
    <div id="otp" contenteditable="true" role="textbox" autocomplete="one-time-code">418922</div>
    <label>Notes <textarea id="n">plain notes</textarea></label>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox \[ref_1\] secret filled/, 'no name at all, rather than the key as its name')
  assert.match(tree, /- textbox \[ref_2\] secret filled/)
  assert.doesNotMatch(tree, /BEGIN KEY|418922/)
  for (const call of ['__hd.rect("ref_1")', '__hd.focus("ref_1")', '__hd.rect("ref_2")', '__hd.focus("ref_2")']) {
    assert.equal((helper(call) as { name: string }).name, '', `${call} handed the secret back as a name`)
  }
  // An ordinary control keeps the name its label gives it.
  assert.match(tree, /- textbox "Notes" \[ref_3\] value="plain notes"/)
})

test('the tree and fill give one answer about whether a secret field holds anything', () => {
  // Found by review: a contenteditable's `el.value` is undefined, which the
  // tree read as empty and fill() read as filled — about the same field.
  const { helper } = page(`<div id="otp" contenteditable="true" role="textbox" autocomplete="one-time-code">418922</div>`)
  helper('__hd.tree({})')
  assert.match(String(helper('__hd.tree({})')), /secret filled/, 'its text is its value')
  assert.deepEqual(helper('__hd.fill("ref_1", "")'), { role: 'textbox', name: '', secret: true, filled: false })
  assert.match(String(helper('__hd.tree({})')), /secret empty/, 'and both still agree once it is cleared')
  assert.deepEqual(helper('__hd.fill("ref_1", "999111")'), { role: 'textbox', name: '', secret: true, filled: true })
  assert.match(String(helper('__hd.tree({})')), /secret filled/)
})

test('a secret contenteditable is redacted from the page read as text, where its value is its text', () => {
  const { helper } = page(`
    <p>Enter the code below.</p>
    <div contenteditable="true" role="textbox" autocomplete="one-time-code">418922</div>
    <input type="password" value="hunter2">`)
  const asText = String(helper('__hd.text({})'))
  assert.match(asText, /Enter the code below\./)
  assert.doesNotMatch(asText, /418922/, 'innerText reads a contenteditable in the clear')
  assert.doesNotMatch(asText, /hunter2/, 'an input was never text to begin with')
})

test('a wait cannot be used to spell out a value one letter at a time', () => {
  // `settled({selector})` answers true/false, and CSS attribute selectors
  // match the value *attribute* a server-rendered form ships in its markup.
  const { helper } = page(`<input id="pw" type="password" value="apple">`)
  assert.throws(() => helper(`__hd.settled({ selector: 'input[type="password"][value^="a"]' })`), /reads the field/)
  assert.throws(() => helper(`__hd.settled({ selector: '#pw[value*="ppl"]' })`), /reads the field/, 'naming no secret asks the same question')
  // A wait for something that is not a value still works.
  assert.equal(helper(`__hd.settled({ selector: '#pw' })`), true)
  assert.equal(helper(`__hd.settled({ selector: '#nope' })`), false)
})

test('every token in SECRET_AUTOCOMPLETE is honoured, current-password included', () => {
  const { helper } = page(`
    <label>A <input id="a" autocomplete="current-password" value="one"></label>
    <label>B <input id="b" autocomplete="new-password" value="two"></label>
    <label>C <input id="c" autocomplete="one-time-code" value="three"></label>
    <label>D <input id="d" autocomplete="username" value="four"></label>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox "A" \[ref_1\] secret filled/)
  assert.match(tree, /- textbox "B" \[ref_2\] secret filled/)
  assert.match(tree, /- textbox "C" \[ref_3\] secret filled/)
  assert.match(tree, /- textbox "D" \[ref_4\] value="four"/, 'a username is not a secret')
  assert.doesNotMatch(tree, /"one"|"two"|"three"/)
})

test('a card number and its CVC are secrets on a checkout form the same way a password is', () => {
  const { helper } = page(`
    <label>Card number <input id="pan" autocomplete="cc-number" value="4111111111111111"></label>
    <label>CVC <input id="csc" autocomplete="cc-csc" value="737"></label>
    <label>Expiry <input id="exp" autocomplete="cc-exp" value="04/28"></label>
    <label>Name on card <input id="cn" autocomplete="cc-name" value="Ada Lovelace"></label>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- textbox "Card number" \[ref_1\] secret filled/)
  assert.match(tree, /- textbox "CVC" \[ref_2\] secret filled/)
  assert.match(tree, /- textbox "Expiry" \[ref_3\] secret filled/)
  assert.match(tree, /- textbox "Name on card" \[ref_4\] value="Ada Lovelace"/, 'a cardholder’s name is not the secret')
  assert.doesNotMatch(tree, /4111|737|04\/28/)
})

test('a select can be secret too, and reports the same way a text field does', () => {
  const { helper } = page(`
    <label>Expiry year <select id="y" autocomplete="cc-exp-year"><option value="2028">2028</option><option value="2029">2029</option></select></label>`)
  const tree = String(helper('__hd.tree({})'))
  assert.match(tree, /- combobox "Expiry year" \[ref_1\] secret filled/)
  assert.doesNotMatch(tree, /2028/)
  assert.deepEqual(helper('__hd.fill("ref_1", "2029")'), { role: 'combobox', name: 'Expiry year', secret: true, filled: true })
})
