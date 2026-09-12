import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ACCOUNTS, ANONYMOUS, VOUCHED, accountFor } from './shots/accounts.mjs'
import { COLLECT, accountReasons, reasonsFor, textReasons } from './shots/audit.mjs'
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

test('the invented desk the rig stages is still publishable (#296)', () => {
  /* The direction that stops this from becoming "refuse everything". Built out
     of `cast.mjs` itself rather than out of prose about it, so that widening
     the audit against the real staged strings is what is being asserted — the
     twelve agents, their conversations, the repositories, the seat accounts
     and a tildified path. If any arm above starts refusing the rig's own desk,
     this is what goes red. */
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
  const seen = {
    ...frame(lines.join('\n'), [
      ['title', '~/work/storefront'],
      ['alt', 'Codex'],
    ]),
    accounts: Object.fromEntries(CAST.map((agent) => [agent.id, accountFor(agent.id)])),
  }
  assert.deepEqual(reasonsFor(seen, { user: USER, vouched: VOUCHED }), [])
})
