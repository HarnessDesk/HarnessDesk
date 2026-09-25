import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ACCOUNTS, ANONYMOUS, VOUCHED, accountFor } from './shots/accounts.mjs'
import {
  COLLECT,
  SEEN,
  TILDIFY,
  accountReasons,
  reasonsFor,
  refuseUnpublishable,
  refuseUnvouchedAccounts,
  textReasons,
} from './shots/audit.mjs'
import { CAST, CONVERSATIONS, OLIVIA, REPOS, SHANE } from './shots/cast.mjs'

/**
 * The screenshot rig's audit, tested — because it passed a real account.
 *
 * A take put a real name and a real email address on a seat and the audit
 * said the frame was publishable; a person reading the picture caught it
 * (#296). Nothing was published, and the frames are not a gate — nothing in
 * CI runs the rig — so this file is the only thing that can say the audit
 * still refuses what it was taught to refuse.
 *
 * Every test here is a pair. One direction is a frame that must be **refused**
 * — an address, a display name, a home path under any root, and each of those
 * hidden in an attribute instead of in body text. The other is the invented
 * desk the rig actually stages, which must still be **accepted**: an audit
 * that refuses everything is an audit that gets commented out on the first
 * take, and it would be exactly as useless as the one this replaces.
 *
 * The addresses below are `.invalid` names, which are unregistrable by
 * definition, and the homes and people are invented — the same rule 13 this
 * audit enforces, applied to the audit's own fixtures.
 */

/** One frame, as `COLLECT` hands it back. */
const frame = (text, attributes = []) => ({ text, documentTitle: 'HarnessDesk', attributes })

/** A username this machine does not have, so the arm is exercised, never the tester's. */
const USER = 'ahamilton'

test('a frame carrying an address outside the sanctioned domains is refused (#296)', () => {
  const refused = textReasons(frame('Cline\nj.roe@northwind-trading.invalid \u00b7 Pro'), { user: USER }) // hd-secrets-ok
  assert.equal(refused.length, 1)
  assert.match(refused[0], /rule 13/)
  /* The controls: every address the staged desk really renders. The demo
     persona is the one the cast is built from, `dev@example.com` is what the
     fake agents sign in as, and `acme.dev` is the second-company placeholder
     the fixtures lean on. If widening this refused any of them the rig would
     be unable to photograph its own desk. */
  for (const line of [
    `Codex\n${SHANE.email} \u00b7 Team`,
    `Claude\n${OLIVIA.email} \u00b7 Pro`,
    'fake-codex signs in as dev@example.com',
    'olivia@acme.dev',
    'git@github.com:openma/harnessdesk.git',
  ]) {
    assert.deepEqual(textReasons(frame(line), { user: USER }), [], line)
  }
})

test('a frame carrying a home directory is refused under every root (#296)', () => {
  /* The old audit's pattern was `/Users/…` and nothing else, so a Linux or a
     Windows desk photographed its owner's login name with the rig reporting
     the frame clean. */
  for (const line of [
    'Opened /Users/jroe/code/ledger-api', // hd-secrets-ok
    'Opened /home/jroe/code/ledger-api', // hd-secrets-ok
    'Opened C:\\Users\\jroe\\code\\ledger-api', // hd-secrets-ok
  ]) {
    const refused = textReasons(frame(line), { user: USER })
    assert.equal(refused.length, 1, line)
    assert.match(refused[0], /rule 13/, line)
  }
  /* The controls: what a staged frame looks like after `tildify`, and the
     placeholder homes the roster already sanctions. */
  for (const line of [
    'Opened ~/work/storefront',
    "PATH: '/opt/homebrew/bin:/Users/x/.local/bin'",
    'C:\\Users\\someone\\project',
  ]) {
    assert.deepEqual(textReasons(frame(line), { user: USER }), [], line)
  }
})

test('an address or a home path hidden in a title or an alt is refused (#296)', () => {
  /* `tildify` walks `[title]` because it knows attributes carry paths; the
     audit read `innerText` only and never followed it there, so a tooltip was
     the one surface on screen nothing looked at. */
  const inTitle = textReasons(frame('Nothing to see', [['title', 'j.roe@northwind-trading.invalid']]), { user: USER }) // hd-secrets-ok
  assert.equal(inTitle.length, 1)
  assert.match(inTitle[0], /a title attribute/)
  const inAlt = textReasons(frame('Nothing to see', [['alt', '/home/jroe/avatar.png']]), { user: USER }) // hd-secrets-ok
  assert.equal(inAlt.length, 1)
  assert.match(inAlt[0], /an alt attribute/)
  // The window's own title is read too — it is text the reader can see.
  const inWindow = textReasons({ ...frame('clean'), documentTitle: '/home/jroe/code' }, { user: USER }) // hd-secrets-ok
  assert.equal(inWindow.length, 1)
  assert.match(inWindow[0], /the window title/)
  // The control: the attributes a staged frame really carries.
  assert.deepEqual(
    textReasons(frame('Storefront', [['title', '~/work/storefront'], ['alt', 'Codex']]), { user: USER }),
    [],
  )
})

test('tildifying a personal agent worktree does not make it publishable', () => {
  for (const path of ['~/.codex/worktrees/demo/private-repo', '~/.claude/worktrees/private-repo', '~/.harnessdesk/worktrees/private-repo']) {
    const refused = textReasons(frame('Nothing to see', [['title', path]]), { user: USER })
    assert.ok(refused.some(reason => /worktree/.test(reason)), path)
    assert.ok(refused.every(reason => !reason.includes('private-repo')), 'refusal must not repeat private text')
  }
  assert.deepEqual(textReasons(frame('~/work/storefront/.worktrees/sidebar-1'), { user: USER }), [])
})

test('history outside the staged repositories is refused even when its row is not visible', () => {
  const history = [{ runtime: 'shots-opencode', id: 'unvouched', cwd: '/home/someone/private-repo' }]
  const refused = reasonsFor({ ...frame('Storefront'), history }, { roots: ['/tmp/rig/work/storefront'] })
  assert.ok(refused.some(reason => /history/.test(reason)))
  assert.ok(refused.every(reason => !reason.includes('private-repo')))
  assert.deepEqual(reasonsFor({ ...frame('Storefront'), history: [{ ...history[0], cwd: '/tmp/rig/work/storefront/.worktrees/sidebar-1' }] }, { roots: ['/tmp/rig/work/storefront'] }), [])
})

test('only the exact native fake-Codex history is allowed outside staged repositories', () => {
  const options = { roots: ['/tmp/rig/work/storefront'], nativeCodex: true }
  const fixture = { runtime: 'codex', id: 'thread-e2e', cwd: '/w' }
  assert.deepEqual(reasonsFor({ ...frame('Storefront'), history: [fixture] }, options), [])
  for (const row of [{ ...fixture, id: 'other' }, { ...fixture, runtime: 'opencode' }, { ...fixture, cwd: '/tmp/private-repo' }]) {
    assert.ok(reasonsFor({ ...frame('Storefront'), history: [row] }, options).some(reason => /history/.test(reason)))
  }
  assert.ok(reasonsFor({ ...frame('Storefront'), history: [fixture] }, { roots: options.roots }).some(reason => /history/.test(reason)))
})

test('the frame audit collects both hidden history and loaded conversations from the same snapshot', () => {
  const history = { runtime: 'shots-opencode', id: 'old', cwd: '/tmp/rig/work/storefront' }
  const loaded = { runtime: 'shots-cursor', id: 'open', cwd: '/tmp/rig/work/atlas-api', turns: [{ text: 'not needed by the audit' }] }
  const document = { title: 'HarnessDesk', body: { innerText: 'Storefront' }, querySelectorAll: () => [] }
  const window = { __hdStore: { getSnapshot: () => ({ history: [history], sessions: new Map([['open', loaded]]), accountsByRuntime: {} }) } }
  const seen = new Function('document', 'window', `return ${SEEN}`)(document, window)
  assert.deepEqual(seen.history, [history, { runtime: loaded.runtime, id: loaded.id, cwd: loaded.cwd }])
})

test("this machine's username is refused, and the reason does not quote it (#296)", () => {
  for (const seen of [frame(`~ahamilton/work`), frame('clean', [['title', 'ahamilton']])]) {
    const refused = textReasons(seen, { user: USER })
    assert.equal(refused.length, 1)
    assert.match(refused[0], /username/)
    /* The message is printed on the machine that owns the name, and a
       terminal is one paste away from a pull request body. Naming the surface
       is enough to find it. */
    assert.doesNotMatch(refused[0], new RegExp(USER))
  }
  // The control: the same frames without it.
  assert.deepEqual(textReasons(frame('~/work'), { user: USER }), [])
})

test('a suppression marker in a frame does not suppress the frame (#296)', () => {
  /* `hd-secrets-ok` is an author's mark on their own tracked line. Rendered
     text is nobody's authored line: a frame showing a diff, a code block, or
     this repository's own gate source would otherwise switch the audit off for
     whatever was drawn beside it. */
  const refused = textReasons(frame('j.roe@northwind-trading.invalid hd-secrets-ok'), { user: USER })
  assert.equal(refused.length, 1)
  assert.match(refused[0], /rule 13/)
})

test('an account the rig did not author is refused, address or no address (#296)', () => {
  /* The half no text rule can reach. A display name has no shape to match on,
     so `Jordan Roe` on a seat is indistinguishable from `Codex` — and that is
     what a real runtime reported onto the staged desk. The rig authors every
     account, so anything else came from a credential store on this machine. */
  const refused = accountReasons(
    { cline: { accounts: [{ kind: 'agent', label: 'Jordan Roe' }] } },
    { vouched: VOUCHED },
  )
  assert.equal(refused.length, 1)
  assert.match(refused[0], /cline/)
  // And it does not quote what it found, for the same reason the username arm does not.
  assert.doesNotMatch(refused[0], /Jordan Roe/)
  // The control: every identity `accounts.mjs` writes, and the anonymous seat.
  const staged = Object.fromEntries(CAST.map((agent) => [agent.id, accountFor(agent.id)]))
  assert.deepEqual(accountReasons(staged, { vouched: VOUCHED }), [])
  assert.deepEqual(accountReasons({ amp: ANONYMOUS }, { vouched: VOUCHED }), [])
})

test('the rig answers every runtime, including one it has never heard of (#296)', () => {
  /* Totality is the property that matters: the leak arrived on a seat nobody
     had thought about, so an answer that covers the anticipated runtimes is
     the same hole one id over. */
  assert.equal(accountFor('a-runtime-nobody-added-yet'), ANONYMOUS)
  assert.equal(accountFor('a-runtime-nobody-added-yet').accounts[0].anonymous, true)
  assert.equal(accountFor('codex').accounts[0].email, SHANE.email)
  // Two accounts on one agent, which is a state the interface draws differently.
  assert.equal(ACCOUNTS['claude-code'].accounts.length, 2)
  // Every authored identity is vouched for, or the audit refuses the rig's own desk.
  for (const status of [...Object.values(ACCOUNTS), ANONYMOUS]) {
    for (const account of status.accounts) {
      assert.ok(VOUCHED.has(account.label), account.label)
      if (account.email) assert.ok(VOUCHED.has(account.email), account.email)
    }
  }
})

test('the collector reads titles and alts, not only the body text (#296)', () => {
  /* The expression runs in the renderer, where no test can reach it, so it is
     exercised here against a document of our own. It is the half of the
     widening that lives in a string, and a string cannot be typechecked. */
  const asked = []
  const document = {
    title: 'HarnessDesk',
    body: { innerText: 'the body' },
    querySelectorAll: (selector) => {
      asked.push(selector)
      if (selector === 'input:not([type=hidden]), textarea') return []
      return [
        { tagName: 'SPAN', className: 'path', getAttribute: (name) => (name === 'title' ? '~/work/storefront' : null) },
        { tagName: 'IMG', className: '', getAttribute: (name) => (name === 'alt' ? 'Codex' : null) },
      ]
    },
  }
  const seen = new Function('document', `return ${COLLECT}`)(document)
  assert.deepEqual(asked, ['[title], [alt]', 'input:not([type=hidden]), textarea'], 'both attributes are asked for in one pass, then the fields')
  assert.equal(seen.text, 'the body')
  assert.equal(seen.documentTitle, 'HarnessDesk')
  assert.deepEqual(seen.attributes, [
    ['title', '~/work/storefront', 'span', 'path'],
    ['alt', 'Codex', 'img', ''],
  ])
})

test('the collector reads what a field holds, which is neither text nor an attribute', () => {
  /* The browser pane's address bar is an `<input>`: its URL lives in the
     field's `value` property, which `innerText` skips and no attribute
     carries. A rig frame showed a real home path there and the audit passed
     it. A declared placeholder home stands in for the real one. */
  const field = { tagName: 'INPUT', className: 'address', value: 'file:///home/someone/work/browse/index.html' }
  const empty = { tagName: 'TEXTAREA', className: '', value: '' }
  const document = {
    title: 'HarnessDesk',
    body: { innerText: '' },
    querySelectorAll: (selector) => (selector === 'input:not([type=hidden]), textarea' ? [field, empty] : []),
  }
  const seen = new Function('document', `return ${COLLECT}`)(document)
  assert.deepEqual(seen.attributes, [['value', field.value, 'input', 'address']], 'an empty field adds nothing')
  const reasons = textReasons(seen, { user: 'someone' })
  assert.ok(
    reasons.some((reason) => reason.startsWith('a value attribute on input.address')),
    `the field's contents are refused like any other text: ${JSON.stringify(reasons)}`,
  )
})

/**
 * The invented desk the rig actually stages, as one window.
 *
 * Built out of `cast.mjs` itself rather than out of prose about it, so what is
 * asserted is the real staged strings — the twelve agents, their
 * conversations, the repositories, the seat accounts and a tildified path.
 * Shared by every accept-direction test below: a still that must still be
 * written, and a recording that must still be recorded.
 */
const stagedWindow = () => {
  const lines = [
    'Workspaces',
    ...REPOS.map((repo) => `${repo.name} \u2014 ${repo.blurb}`),
    ...CAST.map((agent) => `${agent.name} \u00b7 ${agent.tagline}`),
    ...Object.values(CONVERSATIONS)
      .flat()
      .flatMap(([title, , , answer]) => [title, answer]),
    ...Object.values(ACCOUNTS)
      .flatMap((status) => status.accounts)
      .map((account) => [account.label, account.planType].filter(Boolean).join(' \u00b7 ')),
    'Signed in',
    '~/work/storefront',
  ]
  return {
    ...frame(lines.join('\n'), [
      ['title', '~/work/storefront'],
      ['alt', 'Codex'],
    ]),
    accounts: Object.fromEntries(CAST.map((agent) => [agent.id, accountFor(agent.id)])),
  }
}

test('the invented desk the rig stages is still publishable (#296)', () => {
  /* The direction that stops this from becoming "refuse everything". If any
     arm above starts refusing the rig's own desk, this is what goes red. */
  assert.deepEqual(reasonsFor(stagedWindow(), { user: USER, vouched: VOUCHED }), [])
})

/**
 * A CDP client that answers for one window, and remembers what it was asked.
 *
 * It routes on the expression because the two gates ask different questions:
 * `SEEN` collects the frame *and* the seats, the mid-take poll asks for the
 * seats alone. Answering both from one object would let the poll be handed a
 * whole window, whose keys are not runtimes — which passes vacuously, and is
 * exactly the shape of miss this file exists for.
 */
const fakeCdp = (window) => ({
  asked: [],
  json(expression) {
    this.asked.push(expression)
    return Promise.resolve(expression.includes('document') ? window() : (window().accounts ?? {}))
  },
})

/** One seat holding somebody the rig did not invent. */
const REAL_SEAT = { cline: { accounts: [{ kind: 'agent', label: 'Jordan Roe', email: 'j.roe@northwind-trading.invalid' }] } } // hd-secrets-ok

test('a recording is refused when the re-staged accounts did not take (#296)', async () => {
  /* The critical unguarded branch: the recording path has no frame-by-frame
     backstop, so a staging step that did not take is published. And the
     failure does not throw — `loadAccounts()` catches every request it makes,
     and returns early when a later pass overtook it, resolving successfully
     having patched nothing. So un-swallowing the call was never the fix. The
     gate reads the map back instead. */
  const cdp = fakeCdp(() => ({ ...stagedWindow(), accounts: REAL_SEAT }))
  await assert.rejects(
    refuseUnpublishable(cdp, { name: 'turn-light', user: USER, vouched: VOUCHED, subject: 'recording' }),
    (error) => {
      assert.match(error.message, /this recording is not publishable/)
      assert.match(error.message, /cline/, 'the seat to look at is named')
      /* And what it found is not quoted, for the reason the username is not:
         if this arm is right, it is holding somebody's account. */
      assert.doesNotMatch(error.message, /Jordan Roe/)
      assert.doesNotMatch(error.message, /j\.roe/)
      return true
    },
  )
})

test('an ordinary take against the rig\'s invented desk still records (#296)', async () => {
  /* The other direction, and the one that stops this from becoming "refuse
     every recording". Both gates, over the desk the rig really stages. */
  const cdp = fakeCdp(stagedWindow)
  await refuseUnpublishable(cdp, { name: 'turn-light', user: USER, vouched: VOUCHED, subject: 'recording' })
  await refuseUnvouchedAccounts(cdp, { name: 'turn-light', vouched: VOUCHED })
  /* The poll asked the store, not the DOM: a `[title]` sweep six times during
     a screencast is jank recorded into the artifact. */
  assert.doesNotMatch(cdp.asked[1], /document/)
  assert.match(cdp.asked[1], /accountsByRuntime/)
})

test('a seat that arrives mid-take is refused before the frames are written (#296)', async () => {
  /* The one door neither bracket can see. An account that appears after the
     staging did — a second slot, an agent registered from the interface — is
     the third read-through door `accounts.mjs` names, and the only one that
     opens while the screencast is running. */
  let sample = 0
  const cdp = fakeCdp(() => ({ ...stagedWindow(), accounts: (sample += 1) > 2 ? REAL_SEAT : stagedWindow().accounts }))
  await refuseUnvouchedAccounts(cdp, { name: 'turn-light', vouched: VOUCHED })
  await refuseUnvouchedAccounts(cdp, { name: 'turn-light', vouched: VOUCHED })
  await assert.rejects(
    refuseUnvouchedAccounts(cdp, { name: 'turn-light', vouched: VOUCHED }),
    /this recording is not publishable/,
  )
})

test('the recording path refuses before it records and before it writes (#296)', () => {
  /* The gate above is only worth having if the recording actually asks it, and
     nothing else in this file can see that: `gif.mjs` launches an Electron app
     at import, so its order is read rather than run. Both positions matter —
     before the screencast, because a refusal there costs a launch rather than
     a take; and after it, before a single frame reaches the disk. */
  const gif = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'shots/gif.mjs'), 'utf8')
  // The call, not the import line — matching the bare name would pass on the import alone.
  const first = gif.indexOf('refuseUnpublishable(cdp')
  const last = gif.lastIndexOf('refuseUnpublishable(cdp')
  const poll = gif.indexOf('refuseUnvouchedAccounts(cdp')
  const starts = gif.indexOf("Page.startScreencast")
  const stops = gif.indexOf("Page.stopScreencast")
  const writes = gif.indexOf('writeFileSync(join(FRAMES')
  for (const [what, at] of [['the gate', first], ['the poll', poll], ['the screencast', starts], ['the write', writes]]) {
    assert.notEqual(at, -1, `gif.mjs still has ${what}`)
  }
  assert.ok(first < starts, 'the recording is refused before a frame is captured')
  assert.ok(poll > starts && poll < stops, 'and asked again while it records')
  assert.ok(last > stops && last < writes, 'and once more before a frame reaches the disk')
  assert.notEqual(first, last, 'the two gates are two calls')
  /* And the re-ask that closes the boot race is not swallowed. It is the
     smaller half — neither verb can fail loudly, which is why the gates read
     the answers back — but a dead renderer should stop the take, not be
     ignored by the one path with no frame-by-frame backstop. */
  const reAsk = gif.split('\n').filter((line) => line.includes('cdp.eval') && /loadAccounts|refreshRuntime/.test(line))
  assert.equal(reAsk.length, 2, 'both slots are re-asked')
  for (const line of reAsk) assert.doesNotMatch(line, /catch/, line.trim())
})

test('the substitution both drivers run covers attributes, not only text (#296)', () => {
  /* Why this is a test and not a detail: there were two copies of `tildify`
     and they had drifted — the stills walked `[title]` and the recording did
     not. Widening the audit to read attributes without closing that would have
     refused every ordinary recording, for a tooltip the rig itself left there.
     It runs in the renderer, so it is exercised here against a document of our
     own, the way `COLLECT` is. */
  /* A declared placeholder home, not a lookalike needing `hd-secrets-ok`:
     the substitution is literal, so the fixture may as well be one the
     tracked-files gate already sanctions. */
  const home = '/home/someone'
  const text = [{ nodeValue: `Opened ${home}/work/storefront` }, { nodeValue: 'nothing to change' }]
  const titled = {
    value: `${home}/work/storefront`,
    getAttribute: (name) => (name === 'title' ? titled.value : null),
    setAttribute: (name, value) => {
      titled.value = value
    },
  }
  const field = { value: `file://${home}/work/browse/index.html` }
  const asked = []
  let next = 0
  const document = {
    body: {},
    createTreeWalker: () => ({ nextNode: () => text[next++] ?? null }),
    querySelectorAll: (selector) => {
      asked.push(selector)
      return selector === 'input:not([type=hidden]), textarea' ? [field] : [titled]
    },
  }
  new Function('document', 'NodeFilter', `return ${TILDIFY(home)}`)(document, { SHOW_TEXT: 4 })
  assert.equal(text[0].nodeValue, 'Opened ~/work/storefront')
  assert.equal(text[1].nodeValue, 'nothing to change')
  assert.deepEqual(asked, ['[title]', 'input:not([type=hidden]), textarea'])
  assert.equal(titled.value, '~/work/storefront', 'the tooltip the recording used to leave standing')
  assert.equal(field.value, 'file://~/work/browse/index.html', 'the address bar, which is a field and not text')
})

test('tildify redacts a home prefix wherever a path actually starts, and never mid-word (#904, #909)', () => {
  /* Round one of this fix (#904) tried several candidate homes to cover a
     symlink-resolved one as well as the as-given one — but `config.mjs` now
     resolves `HOME`/`WORK` at the source, so the real fix for that is there,
     not here (#909 review, P3-2), and a single candidate is what every
     driver actually passes. What still belongs here is the boundary itself:
     the old rule only recognised whitespace, a quote or an opening bracket as
     "before a path", and only a slash or the end of the string as "after
     one" — so it missed a home inside a `file://` URL (the browser scene's
     own tab title), a `cwd=` prefix, a second PATH-style entry after `:`, and
     a home followed by a space or closing punctuation. On main, the plain
     `split(home).join('~')` this replaced shortened every one of those; this
     rule has to as well, or the audit covers less than it used to and a
     frame that used to publish clean now fails on the raw path — better than
     a leak, but a real regression the review caught (#909 P2-1).

     The one thing it still must reject is a match *inside* a longer path
     segment — `/var` inside `/private/var`, or `jane` inside `janeway` or
     `jane.txt` — which is why the boundary is "not a character that could
     continue a bare name" rather than a fixed list of what may precede or
     follow it. */
  const home = '/Users/jane' // hd-secrets-ok
  const cases = [
    ['Opened /Users/jane/work/storefront', 'Opened ~/work/storefront'], // hd-secrets-ok
    // The browser scene's own tab title: `${name}\n${url}` with a file:// URL
    // (packages/ui/src/components/BrowserPane.tsx). The third slash is a
    // boundary of its own, not a path character.
    ['file:///Users/jane/work/browser-fixture.html', 'file://~/work/browser-fixture.html'], // hd-secrets-ok
    ['cwd=/Users/jane/work', 'cwd=~/work'], // hd-secrets-ok
    // A second PATH-style entry: the character before it is the separator, not a boundary character on any fixed list.
    ['/Users/jane/bin:/Users/jane/.local/bin', '~/bin:~/.local/bin'], // hd-secrets-ok
    ['Opened /Users/jane in Finder', 'Opened ~ in Finder'], // hd-secrets-ok
    ['Home: /Users/jane.', 'Home: ~.'], // hd-secrets-ok
    ['(/Users/jane)', '(~)'], // hd-secrets-ok
    ["'/Users/jane'", "'~'"], // hd-secrets-ok
    // Must not fire inside a longer, unrelated name that merely starts the same way.
    ['/Users/janeway/work', '/Users/janeway/work'], // hd-secrets-ok
    ['/Users/jane.txt', '/Users/jane.txt'], // hd-secrets-ok
    // A work folder with nothing to do with home must survive untouched.
    ['/tmp/rig/work/storefront and /Users/jane/work/storefront', '/tmp/rig/work/storefront and ~/work/storefront'], // hd-secrets-ok
    ['nothing to change', 'nothing to change'],
  ]
  const text = cases.map(([input]) => ({ nodeValue: input }))
  let next = 0
  const document = {
    body: {},
    createTreeWalker: () => ({ nextNode: () => text[next++] ?? null }),
    querySelectorAll: () => [],
  }
  new Function('document', 'NodeFilter', `return ${TILDIFY(home)}`)(document, { SHOW_TEXT: 4 })
  for (const [index, [input, expected]] of cases.entries()) {
    assert.equal(text[index].nodeValue, expected, input)
  }
})

test('tildify still refuses a shorter candidate matching inside a longer, resolved prefix (#904)', () => {
  /* The original bug: macOS resolves `/var` to `/private/var`, and an
     as-given, pre-resolution home matched itself out of the middle of the
     resolved path, leaving "/private~/storefront" standing. `config.mjs` now
     resolves `HOME`/`WORK` before anything reads them, so this is defence in
     depth for whatever still calls `TILDIFY` with an unresolved value. */
  const asGiven = '/var/folders/xx/home' // hd-secrets-ok
  const original = `Opened /private${asGiven}/storefront`
  const node = { nodeValue: original }
  let served = false
  const document = {
    body: {},
    createTreeWalker: () => ({
      nextNode: () => {
        if (served) return null
        served = true
        return node
      },
    }),
    querySelectorAll: () => [],
  }
  new Function('document', 'NodeFilter', `return ${TILDIFY(asGiven)}`)(document, { SHOW_TEXT: 4 })
  assert.equal(node.nodeValue, original, 'the as-given candidate must not fire in the middle of the resolved path')
})
