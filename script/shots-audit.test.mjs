import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ACCOUNTS, ANONYMOUS, VOUCHED, accountFor } from './shots/accounts.mjs'
import {
  COLLECT,
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
      return [
        { getAttribute: (name) => (name === 'title' ? '~/work/storefront' : null) },
        { getAttribute: (name) => (name === 'alt' ? 'Codex' : null) },
      ]
    },
  }
  const seen = new Function('document', `return ${COLLECT}`)(document)
  assert.deepEqual(asked, ['[title], [alt]'], 'both attributes are asked for in one pass')
  assert.equal(seen.text, 'the body')
  assert.equal(seen.documentTitle, 'HarnessDesk')
  assert.deepEqual(seen.attributes, [
    ['title', '~/work/storefront'],
    ['alt', 'Codex'],
  ])
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
  const asked = []
  let next = 0
  const document = {
    body: {},
    createTreeWalker: () => ({ nextNode: () => text[next++] ?? null }),
    querySelectorAll: (selector) => {
      asked.push(selector)
      return [titled]
    },
  }
  new Function('document', 'NodeFilter', `return ${TILDIFY(home)}`)(document, { SHOW_TEXT: 4 })
  assert.equal(text[0].nodeValue, 'Opened ~/work/storefront')
  assert.equal(text[1].nodeValue, 'nothing to change')
  assert.deepEqual(asked, ['[title]'])
  assert.equal(titled.value, '~/work/storefront', 'the tooltip the recording used to leave standing')
})
