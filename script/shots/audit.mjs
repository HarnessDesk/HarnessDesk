/**
 * Whether one frame may be published.
 *
 * The audit this replaces threw on two strings: this machine's username, and
 * any `/Users/<name>` path. Its own comment called the username "the one
 * string no frame may contain" — and that framing was the defect. A real
 * display name and a real address matched neither, so a take that put both on
 * a seat was passed by the rig and caught by a person reading the picture
 * (#296). Nothing was published; the hole was live for every take after it.
 *
 * Two changes of direction, and they are the point of the file:
 *
 *  - **It refuses what it cannot vouch for, rather than hunting for what it
 *    knows is bad.** `check-secrets.mjs` already decides exactly this question
 *    for tracked files — an address whose domain is not a reserved
 *    documentation name, `acme.dev`, or the project's demo persona — and it
 *    was hardened twice against smuggling. So a frame is handed to that gate's
 *    own `offendersIn` rather than to a second opinion written here. One
 *    roster, one reasoning: this repository has closed three "one rule, two
 *    copies" issues this month and a fourth would be the same mistake.
 *  - **An account is something it knows about.** A display name has no shape
 *    to match on, so no text rule can refuse `Jordan Roe`. What the rig can do
 *    is author every account itself (`accounts.mjs`) and then refuse any
 *    account on screen it did not author. That one question catches the real
 *    name, the real address, and — the reason it is worth asking at all — a
 *    staging step that silently failed to install.
 *
 * It also reads more than the body text. `tildify()` has always walked
 * `[title]` attributes because it knows attributes carry paths; the audit
 * never followed it there, so a tooltip or an `alt` was unaudited. Both are
 * read here, with the window's own title.
 *
 * **Which way this errs, and why.** Toward refusing. A false positive costs a
 * retake, measured in minutes, and the message names what to look at; a false
 * negative publishes somebody's account to a public repository, and GitHub
 * keeps what was pushed for a while after it is deleted, so it is never fully
 * undone. `check-secrets.mjs` makes the same trade in its own header, and the
 * frame is the more exposed of the two. What stops that from becoming "refuse
 * everything" is the other direction, pinned by a test: the rig's own invented
 * desk — `dev@example.com`, the demo persona, twelve fictional agents — still
 * passes.
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

import { offendersIn } from '../check-secrets.mjs'
import { STORE } from '../lib/desk.mjs'
import { CAST, rigRuntimeId } from './cast.mjs'

/**
 * The username this machine runs as.
 *
 * One of the things no frame may contain, and no longer the only one — the
 * audit that called it "the one string" passed a real name and a real address
 * on a seat (#296). It is still worth its own check: it is the one name this
 * machine is certain to know. It lives here rather than in a driver because
 * both drivers need it and there is one right answer.
 */
export const USER = homedir().split('/').filter(Boolean).pop() ?? ''

/**
 * Escaped for literal use inside a `RegExp` source string — every character
 * `RegExp` would otherwise read as a metacharacter, neutralized.
 */
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A path starts here, and a path ends there — read off what a bare name is
 * made of, not off a fixed list of what may sit next to one.
 *
 * The first attempt (#904) listed the characters allowed before a path
 * (whitespace, a quote, an opening bracket) and after one (a slash, the end
 * of the string). Real frames carry a home in shapes that list never
 * anticipated: a `file://` URL, where the boundary is the third slash; a
 * `cwd=` prefix; a second `PATH`-style entry after `:`; a name followed by a
 * sentence's closing period or a bare space (#909 review, P2-1). Every one of
 * those was shortened by the plain `split(home).join('~')` this replaced, so
 * the narrower rule was a real regression, not only an incomplete one — a
 * frame that used to publish clean now failed on a raw path.
 *
 * So the rule is inverted: a path starts wherever the character before it
 * could *not* be part of a bare name (`(?<![A-Za-z0-9._~-])`), and it ends
 * wherever the character after it could not continue one, including a
 * dotted continuation like an extension (`(?![A-Za-z0-9_~-]|\.[A-Za-z0-9])`).
 * That is also what keeps a shorter candidate out of the middle of a longer
 * one — `/var` is never read out of `/private/var`, and `home` is never read
 * out of `homework`, because in both the character right before the match
 * would have to be a letter, which the rule refuses.
 */
const NOT_BEFORE_A_PATH = '(?<![A-Za-z0-9._~-])'
const NOT_CONTINUING_A_NAME = '(?![A-Za-z0-9_~-]|\\.[A-Za-z0-9])'

const prefixPattern = (home) => `${NOT_BEFORE_A_PATH}${escapeForRegExp(home)}${NOT_CONTINUING_A_NAME}`

/**
 * Write this machine's home as `~`, the way the app writes it elsewhere.
 *
 * `shortPath` is applied in the Library, the skill sheet and every diff label,
 * but the repository pane's header prints its root absolute — it has no `home`
 * to shorten against, because home reaches the renderer on the library scan
 * rather than on the app snapshot. That is a real if small defect and it is
 * filed as one; it is not this rig's to fix mid-take.
 *
 * So the substitution happens here, and it is deliberately the narrowest one
 * that helps: the exact home prefix becomes `~`, and nothing else changes. The
 * audit therefore still means something — any *other* home path, under any
 * root, and any bare occurrence of the username, still throws.
 *
 * **It walks attributes, and that is why it is here rather than in a driver.**
 * There were two copies of this, and they had drifted: the stills' walked
 * `[title]` and the recording's walked text nodes only. So a tooltip carrying
 * the real home was substituted before a photograph and left standing through
 * a recording — the recording being the take that cannot be audited frame by
 * frame. One copy, and the drift cannot come back.
 *
 * **It only redacts a whole path prefix.** macOS resolves `/var` and `/tmp`
 * to `/private/var` and `/private/tmp`, so a rig home built from the
 * as-given, pre-resolution path never carried the leading `/private` the
 * window actually showed. A plain `split(home).join('~')` found the as-given
 * string in the *middle* of the resolved one and replaced only that, leaving
 * `/private~/storefront` standing — a corrupted path published in its place
 * (#904). `config.mjs` now resolves `HOME`/`WORK` before anything reads them,
 * which is the actual fix for that; the anchor below is what stops the same
 * class of mistake happening again from any other unresolved candidate,
 * without needing to know about more than the one home every driver passes.
 */
export const TILDIFY = (home) => {
  const pattern = home ? prefixPattern(home) : null
  return `(() => {
    const pattern = ${JSON.stringify(pattern)}
    const regex = pattern ? new RegExp(pattern, 'g') : null
    const shorten = (value) => (typeof value === 'string' && regex ? value.replace(regex, '~') : value)
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) {
      const shortened = shorten(node.nodeValue)
      if (shortened !== node.nodeValue) node.nodeValue = shortened
    }
    for (const element of document.querySelectorAll('[title]')) {
      const title = element.getAttribute('title')
      const shortened = shorten(title)
      if (shortened !== title) element.setAttribute('title', shortened)
    }
    // A field's contents live in its \`value\` property, which neither the text
    // walk nor any attribute reaches — the browser pane's address bar is one.
    for (const field of document.querySelectorAll('input:not([type=hidden]), textarea')) {
      const shortened = shorten(field.value)
      if (shortened !== field.value) field.value = shortened
    }
    return true
  })()`
}

/**
 * Every string the window is showing, collected in the renderer.
 *
 * Evaluated over there and handed back as data, so the deciding happens in
 * Node where it can be tested. `innerText` is what a reader sees; the two
 * attributes are what a reader sees on hover, or would see if an image failed
 * to load, and neither has ever been looked at.
 */
export const COLLECT = `(() => {
  const attributes = []
  for (const element of document.querySelectorAll('[title], [alt]')) {
    for (const name of ['title', 'alt']) {
      const value = element.getAttribute(name)
      if (value) attributes.push([
        name,
        value,
        element.tagName?.toLowerCase?.() ?? 'unknown',
        typeof element.className === 'string' ? element.className : '',
      ])
    }
  }
  // What a field holds is not in innerText and not in any attribute: the
  // browser pane's address bar showed a real home path that passed unread.
  for (const field of document.querySelectorAll('input:not([type=hidden]), textarea')) {
    if (typeof field.value === 'string' && field.value !== '') attributes.push([
      'value',
      field.value,
      field.tagName?.toLowerCase?.() ?? 'unknown',
      typeof field.className === 'string' ? field.className : '',
    ])
  }
  return {
    text: document.body.innerText ?? '',
    documentTitle: document.title ?? '',
    attributes,
  }
})()`

/**
 * Everything one decision needs from a live window: the frame, and the seats.
 *
 * One expression rather than two calls, because the halves have to be read at
 * the same instant — an account map fetched a second after the text is a map
 * of a desk that is no longer the one in the picture.
 */
export const SEEN = `(() => {
  const seen = ${COLLECT}
  const snapshot = ${STORE}.getSnapshot()
  seen.accounts = snapshot.accountsByRuntime ?? {}
  seen.history = [...(snapshot.history ?? []), ...(snapshot.sessions?.values() ?? [])]
    .map(({ runtime, id, cwd }) => ({ runtime, id, cwd }))
  return seen
})()`

/**
 * One string, asked of the tracked-files gate.
 *
 * `hd-secrets-ok` suppresses a line there, where it is an author's deliberate
 * mark on their own file. Rendered text is nobody's authored line — a frame
 * showing that token in a diff, a code block or this very file would suppress
 * whatever sat beside it — so the marker is defanged before the scan. Only the
 * marker changes; the rest of the line is reported as it was drawn.
 */
const askTheGate = (where, value) =>
  offendersIn(where, String(value).split('hd-secrets-ok').join('hd-secrets-mark'))

/**
 * An OS temp directory `TILDIFY` did not shorten.
 *
 * This rig's own home moved off the real one and onto a fixed folder under
 * `os.tmpdir()` (`config.mjs`), which is anonymous but still an ugly machine
 * path in a public frame — and the one place that matters most, the browser
 * pane's address bar, is a React-controlled input that writes its "real"
 * value back mid-take, so a DOM substitution over it cannot be trusted to
 * survive to the screenshot (`static-server.mjs` is the actual fix for that
 * one surface: it gives the pane an `http://127.0.0.1` address with no
 * filesystem path in it at all). This is the backstop for everywhere else —
 * refusing the shape of the path rather than any one instance of it, the same
 * way the username check does not need to know what this machine is called.
 */
const OS_TEMP_PATH = /\/private\/var\/folders\/|\/var\/folders\/|\/private\/tmp\/|\/tmp\//

/**
 * Reasons the rendered text is not publishable.
 *
 * The username stays a check — it is the one name this machine is certain to
 * know — but it is no longer *the* check, and the reason never quotes it: the
 * value is a real login name, and a message that carries it is one paste away
 * from being the leak it just prevented.
 */
export const textReasons = ({ text, documentTitle, attributes }, { user } = {}) => {
  const places = [
    ['frame', text],
    ['the window title', documentTitle ?? ''],
    // The article is picked rather than fixed: these names are read by whoever
    // is holding up a take, and "a alt attribute" reads as a broken message
    // about a broken frame.
    ...(attributes ?? []).map(([name, value, tag, className]) => [
      `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} attribute` +
        (tag ? ` on ${tag}${className ? `.${String(className).trim().replace(/\s+/g, '.')}` : ''}` : ''),
      value,
    ]),
  ]
  const reasons = []
  for (const [where, value] of places) {
    reasons.push(...askTheGate(where, value ?? ''))
    if (user && String(value ?? '').includes(user)) {
      reasons.push(`${where}: this machine's username is in it`)
    }
    if (/(?:~|[/\\])[/\\]?\.(?:codex|claude|harnessdesk)[/\\]worktrees(?:[/\\]|\b)/i.test(String(value ?? ''))) {
      reasons.push(`${where}: a personal agent worktree path is in it`)
    }
    if (OS_TEMP_PATH.test(String(value ?? ''))) {
      reasons.push(`${where}: an unshortened OS temp path is in it`)
    }
  }
  return reasons
}

/**
 * Reasons an account on screen is not publishable.
 *
 * The rig answers `runtime/account` for every runtime, so every account the
 * window holds should be one of the identities `accounts.mjs` wrote. Anything
 * else reached the screen from a credential store on this machine — which is
 * the leak — or from a staging step that did not take, which is the same
 * picture with a different cause.
 *
 * The offending value is not quoted, for the reason the username is not: if
 * this arm is right about what it found, it is holding somebody's address.
 * The runtime and the account's kind are enough to know where to look.
 */
export const accountReasons = (accountsByRuntime = {}, { vouched } = {}) => {
  const allowed = vouched ?? new Set()
  const reasons = []
  for (const [runtime, status] of Object.entries(accountsByRuntime)) {
    for (const account of status?.accounts ?? []) {
      const identities = [account?.label, account?.email].filter((one) => typeof one === 'string' && one !== '')
      if (identities.length > 0 && identities.every((one) => allowed.has(one))) continue
      reasons.push(
        `${runtime}: a seat is signed in as somebody this rig did not invent` +
          ` (kind ${JSON.stringify(account?.kind ?? null)}) — the account was not answered from the rig`,
      )
    }
  }
  return reasons
}

/** Check the store too: a collapsed sidebar can hide history a later scene reveals. */
export const historyReasons = (history = [], { roots = [], nativeCodex = false } = {}) => {
  const runtimes = new Set(CAST.map(agent => rigRuntimeId(agent.id)))
  const allowedRoots = roots.map(root => resolve(root))
  return history.flatMap(row => {
    // These four rows are authored in fake-codex.mjs, not a machine store.
    const nativeFixture = nativeCodex && row.runtime === 'codex' && row.cwd === '/w'
      && ['thread-e2e', 'thread-2', 'thread-3', 'thread-4'].includes(row.id)
    const stagedPath = typeof row.cwd === 'string' && isAbsolute(row.cwd)
      && allowedRoots.some(root => resolve(row.cwd) === root || resolve(row.cwd).startsWith(root + sep))
    return runtimes.has(row.runtime) && (stagedPath || nativeFixture)
      ? [] : ['history: a conversation is outside this rig’s staged runtimes or repositories']
  })
}

/** Everything wrong with this frame, in the order a person would look at it. */
export const reasonsFor = (seen, options = {}) => [
  ...textReasons(seen, options),
  ...accountReasons(seen.accounts ?? {}, options),
  ...historyReasons(seen.history ?? [], options),
]

/**
 * Refuse the take unless the window is publishable *right now*.
 *
 * Both drivers ask this, and it is deliberately a question about state rather
 * than about whether a staging call succeeded. The re-ask that closes the boot
 * race cannot fail loudly: `loadAccounts()` catches every request it makes,
 * and drops its own answer on the floor when a later pass overtook it — it
 * resolves, having patched nothing. So a driver that only stopped swallowing
 * errors would still record a real seat. Reading the map back is the only
 * thing that knows.
 */
export const refuseUnpublishable = async (cdp, { name, user, vouched, roots, nativeCodex, subject = 'frame' }) => {
  const seen = await cdp.json(SEEN)
  const reasons = reasonsFor(seen ?? {}, { user, vouched, roots, nativeCodex })
  if (reasons.length > 0) {
    throw new Error(`${name}: this ${subject} is not publishable —\n    ${reasons.join('\n    ')}`)
  }
}

/**
 * The same question about the seats alone — cheap enough to ask mid-take.
 *
 * A recording is bracketed by the full audit, and neither bracket can see the
 * middle. The one door that opens there is an account arriving after the
 * staging did: a second slot, or an agent registered from the interface. That
 * door is an account door by definition, so this asks only the account half —
 * and asks it of the store, touching no DOM, because sweeping every `[title]`
 * six times during a screencast would be jank recorded into the artifact.
 */
export const refuseUnvouchedAccounts = async (cdp, { name, vouched, subject = 'recording' }) => {
  const accounts = await cdp.json(`${STORE}.getSnapshot().accountsByRuntime ?? {}`)
  const reasons = accountReasons(accounts ?? {}, { vouched })
  if (reasons.length > 0) {
    throw new Error(`${name}: this ${subject} is not publishable —\n    ${reasons.join('\n    ')}`)
  }
}
