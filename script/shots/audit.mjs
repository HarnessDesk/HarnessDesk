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

import { offendersIn } from '../check-secrets.mjs'
import { STORE } from '../lib/desk.mjs'

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
 */
export const TILDIFY = (home) => `(() => {
  const home = ${JSON.stringify(home)}
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walk.nextNode())) {
    if (node.nodeValue?.includes(home)) node.nodeValue = node.nodeValue.split(home).join('~')
  }
  for (const element of document.querySelectorAll('[title]')) {
    const title = element.getAttribute('title')
    if (title?.includes(home)) element.setAttribute('title', title.split(home).join('~'))
  }
  return true
})()`

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
      if (value) attributes.push([name, value])
    }
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
  seen.accounts = ${STORE}.getSnapshot().accountsByRuntime ?? {}
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
    ...(attributes ?? []).map(([name, value]) => [`${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} attribute`, value]),
  ]
  const reasons = []
  for (const [where, value] of places) {
    reasons.push(...askTheGate(where, value ?? ''))
    if (user && String(value ?? '').includes(user)) {
      reasons.push(`${where}: this machine's username is in it`)
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

/** Everything wrong with this frame, in the order a person would look at it. */
export const reasonsFor = (seen, options = {}) => [
  ...textReasons(seen, options),
  ...accountReasons(seen.accounts ?? {}, options),
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
export const refuseUnpublishable = async (cdp, { name, user, vouched, subject = 'frame' }) => {
  const seen = await cdp.json(SEEN)
  const reasons = reasonsFor(seen ?? {}, { user, vouched })
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
