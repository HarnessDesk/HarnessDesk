/**
 * A prompt link: `harnessdesk://new?repo=…&prompt=…[&pr=…][&flow=…]`.
 *
 * The one `harnessdesk://` route that carries data into the app, and all it
 * can do is fill a draft. Every other host and path stays a focus hint
 * (`main-window.mjs`). Nothing here reads a token, a code, or any parameter
 * it does not name, and nothing parsed here is ever logged.
 *
 * The link comes from anywhere — a web page, a chat, an issue — so it is
 * untrusted end to end: the parser is strict about shape, the renderer only
 * ever puts the prompt in the composer as plain text, and the person sends it.
 */

/** Longer than any honest link; a bound on what the parser looks at at all. */
export const PROMPT_LINK_MAX_URL = 16 * 1024

/** A prompt longer than this is refused, never cut: a cut prompt is a different prompt. */
export const PROMPT_LINK_MAX_PROMPT = 8000

/** A repository is a name or a path, never a document. */
export const PROMPT_LINK_MAX_REPO = 1024

const FLOW = /^[a-z0-9][a-z0-9-]{0,63}$/
const PR = /^[1-9][0-9]{0,8}$/
/** `owner/name` or `host/owner/name`, as a remote names it. */
const REPO_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,2}$/
/** A POSIX absolute path or a Windows drive path. */
const REPO_PATH = /^(?:\/|[A-Za-z]:[\\/])/

/**
 * C0 controls but newline and tab, DEL, C1 controls, and the bidirectional
 * marks, overrides and isolates: a prompt the person reviews must read the
 * way it will be sent, so nothing invisible may reorder or hide part of it.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

/** Strips what the person could not see, after line endings are made `\n`. */
export const cleanLinkText = value => value.replace(/\r\n?/g, '\n').replace(INVISIBLE, '')

const repoOf = raw => {
  const repo = cleanLinkText(raw).replace(/[\n\t]/g, '').trim()
  if (repo.length === 0 || repo.length > PROMPT_LINK_MAX_REPO) return null
  if (REPO_PATH.test(repo)) return repo
  const name = repo.replace(/\.git$/i, '')
  if (!REPO_NAME.test(name)) return null
  if (name.split('/').some(part => part === '.' || part === '..')) return null
  return name
}

/** Parameters the link may carry. Anything else is ignored, unread. */
const KNOWN = ['repo', 'prompt', 'pr', 'flow']

/**
 * Parses one prompt link, or answers null. Null is the only answer to
 * anything outside the format — a different host, a path, credentials, a
 * port, a fragment, a repeated parameter, an oversized prompt — so a link
 * that is not exactly a prompt link stays exactly a focus hint.
 *
 * Unknown parameters are ignored rather than refused: ignoring one can never
 * make the app do anything, and it lets a newer link still fill a draft in
 * an older app. Their values are never read.
 */
export const parsePromptLink = value => {
  if (typeof value !== 'string' || value.length > PROMPT_LINK_MAX_URL) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'harnessdesk:' || url.hostname !== 'new') return null
  if (url.username || url.password || url.port || url.hash) return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  const params = url.searchParams
  for (const name of KNOWN) if (params.getAll(name).length > 1) return null

  const rawRepo = params.get('repo')
  const rawPrompt = params.get('prompt')
  if (rawRepo === null || rawPrompt === null) return null
  const repo = repoOf(rawRepo)
  if (repo === null) return null
  const prompt = cleanLinkText(rawPrompt)
  if (prompt.trim().length === 0 || [...prompt].length > PROMPT_LINK_MAX_PROMPT) return null

  const rawPr = params.get('pr')
  if (rawPr !== null && !PR.test(rawPr)) return null
  const rawFlow = params.get('flow')
  if (rawFlow !== null && !FLOW.test(rawFlow)) return null

  return Object.freeze({
    repo,
    prompt,
    pr: rawPr === null ? null : Number(rawPr),
    flow: rawFlow,
  })
}

/** The prefix an argv element must start with to be read at all. */
const ARGV_PREFIX = 'harnessdesk://new'

/**
 * Windows and Linux hand the link to the app as a command-line argument —
 * the first instance's own argv on a cold start, a second instance's argv
 * after that. Only an element starting with `harnessdesk://new` is looked
 * at, and only the first such element: one launch is one link.
 */
export const promptLinkFromArgv = argv => {
  if (!Array.isArray(argv)) return null
  const element = argv.find(one => typeof one === 'string' && one.startsWith(ARGV_PREFIX))
  return element === undefined ? null : parsePromptLink(element)
}

/**
 * The one slot a prompt link waits in until the renderer takes it.
 *
 * A link can arrive before there is a window (macOS sends `open-url` before
 * `ready` on a cold start) or while the renderer is still loading, so the
 * link itself is never pushed: the slot keeps it, the window is nudged, and
 * the renderer asks for it once it can act on it. Taking empties the slot, so
 * a link is delivered once — not again on a reload, not twice when a nudge
 * and the renderer's own first ask cross. A newer link replaces one not yet
 * taken: the last link the person opened is the one they meant.
 */
export const createPromptLinkInbox = ({ currentWindow }) => {
  let pending = null
  const nudge = () => {
    const window = currentWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send('harnessdesk:prompt-link', null)
  }
  return {
    offer(link) {
      if (!link) return
      pending = link
      nudge()
    },
    /** Only the app window's own renderer may take it. */
    take(sender) {
      const window = currentWindow()
      if (!window || window.isDestroyed() || sender !== window.webContents) return null
      const link = pending
      pending = null
      return link
    },
    get pending() { return pending },
  }
}
