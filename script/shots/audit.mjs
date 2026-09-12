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
import { offendersIn } from '../check-secrets.mjs'

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
