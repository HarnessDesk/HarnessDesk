#!/usr/bin/env node
/**
 * No secret may be tracked by git.
 *
 * It scans exactly what `git ls-files` reports — the set that would be
 * published — for credential shapes, and fails the build naming the
 * line. Heuristic on purpose: a false positive costs a minute; a leaked token
 * costs a rotation and an apology.
 *
 * Suppress a deliberate lookalike (a test fixture, a documented example) with
 * `hd-secrets-ok` on the same line.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Shannon entropy per character.
 *
 * The tell of a generated credential rather than a word: english prose and
 * camelCase identifiers sit under 3.5 bits, hex lands near 4, and base64 runs
 * past 5. It is what lets the rules below ask "is this random" instead of
 * asking "is this long", which is what a name like `generateSessionToken`
 * would otherwise trip over.
 */
const entropyPerChar = (value) => {
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const share = count / value.length
    bits -= share * Math.log2(share)
  }
  return bits
}

/**
 * Does this value look generated rather than written by a person?
 *
 * Entropy alone cannot decide it: `REPLACE_ME_WITH_KEY` scores 3.58 and a real
 * 38-character hex key scores 3.80, which is far too fine a margin to hang a
 * build gate on. So the shouting-case convention every placeholder follows —
 * capitals, digits and underscores, nothing else — is excluded outright, and
 * entropy is left to rule out the low-variety fillers like `eeeeee…`.
 */
const looksGenerated = (value, minEntropy) =>
  !/^[A-Z0-9_]+$/.test(value) && entropyPerChar(value) >= minEntropy

/**
 * Domains an address committed here may use.
 *
 * The reserved-for-documentation names, the second-company placeholder the
 * fixtures already lean on, and the project's own public demo persona. Rule 13
 * names all three.
 */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.invalid',
  'acme.dev',
  'harnessdesk.app',
])

/**
 * Local parts that name a service rather than a person.
 *
 * The account an address discloses is its local part, so these stay exempt on
 * any domain, sanctioned or not — deliberately, and that is what the rule says
 * it does: it refuses *an account*, and an unattended role address is not one.
 * Round 1 of #278 asked for the choice to be stated rather than assumed, so it
 * is stated here and pinned by a test.
 *
 * Measured over the tree at this head: 22 occurrences need this arm, every
 * one of them a `git` or a `noreply` local part, and seven of them have no
 * other exemption to fall back on — the aliased-host remotes in the project
 * tests and the composer's placeholder among them — so narrowing this would go
 * red on real lines to close a hole nobody has used. Round 1 of #278 put the
 * figure at seventeen and round 2 measured 22; the move is this branch's own
 * fixtures and prose, not the tree, and the count is quoted here rather than
 * left implied because the last one went stale in one round. Re-measure with
 * `node script/check-secrets.mjs` after widening either roster.
 *
 * The residual it leaves is an affiliation rather than an account: a `noreply`
 * at an unsanctioned domain still says this tree knows about that domain. Rule
 * 13 governs accounts; if a domain ever needs governing, that is a different
 * rule with a different roster.
 */
const IMPERSONAL_LOCAL = /^(?:git|no-?reply)$/i

/**
 * Hosts where `user@host:path` is a remote to push to, not somebody's mailbox.
 *
 * The scp arm below cannot tell those two apart by shape, because there is no
 * difference: an address followed by a colon and a path is spelled the same way
 * whether the host serves git or mail. Round 2 of #278 named the two shapes it
 * therefore let through, and the answer is the idiom this file already uses
 * twice — say which names are sanctioned, because a real one and a stand-in
 * look alike. A gate whose whole job is refusing addresses should not keep an
 * arm that matches on a shape that cannot decide.
 *
 * These are the three the tree writes. Adding a fourth — a self-hosted forge,
 * another provider — is one reviewable line, which is the cost this trades for:
 * `a false positive costs a minute; a leaked token costs a rotation and an
 * apology`, as the header of this file puts it.
 */
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

/**
 * Home directory names a committed path may carry.
 *
 * Measured from the tree the day this rule landed: seventeen distinct segments
 * over 341 occurrences, every one of them a placeholder or the demo persona.
 * Fourteen of the seventeen are named here; the other three are excused by
 * shape below — a dotfile directory, and the two elisions. Listing them is the
 * reconciliation #204 asked for — a real login name has no shape to match on,
 * so the only way to refuse one is to say which names are stand-ins. `shane`
 * is the project's public demo persona, whose home appears in the preview
 * fixture and the site's recorded wire; `linuxbrew` is a system account rather
 * than a person.
 */
const PLACEHOLDER_HOMES = new Set([
  'a',
  'ada',
  'agent',
  'alice',
  'dev',
  'linuxbrew',
  'me',
  'sam',
  'shane',
  'someone',
  'u',
  'user',
  'user2',
  'x',
])

const PATTERNS = [
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  {
    label: 'hardcoded credential assignment',
    pattern: /(?:password|passwd|api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{20,}["']/i,
  },
  // A query string is the other place a credential travels in the clear, and
  // it carries no quotes for the rule above to anchor on. This is how the
  // brainstorm server's `?key=` sat in the repository unnoticed.
  {
    label: 'credential in a URL',
    pattern:
      /[?&](?:key|token|secret|password|passwd|api[_-]?key|access[_-]?token|auth|credential|sig)=([A-Za-z0-9%._~+/-]{16,})/i,
    // Only the random-looking ones. A documented `?token=YOUR_TOKEN_HERE`, or a
    // fixture URL carrying an obvious placeholder, is not a leak — and a rule
    // that cried wolf over those would be turned off within a week.
    minEntropy: 3.5,
  },
  /*
   * AGENTS.md rule 13: nothing that leaves the machine carries a real account.
   *
   * Most of what the rule covers — a pull request body, the `screenshots`
   * branch, a video — cannot be checked from here. The half that lives in
   * tracked files can be, and should be precisely because the rest cannot: an
   * address typed into a test or a fixture is as public as a screenshot, and it
   * is the one form of the mistake a gate can catch before it is pushed (#204).
   *
   * Both rules name what is *sanctioned* rather than what is forbidden, because
   * a real name and a placeholder have the same shape. That makes the
   * placeholder vocabulary rule 13 asks for explicit: a new stand-in is added
   * to the rosters above, which is the same idiom as `NOT_IN_CI` in
   * `check-verify-drift.mjs` — the exception recorded where the check reads it.
   */
  {
    label: "a real account's address (AGENTS.md rule 13)",
    pattern: /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    exempt: (match, line) => {
      const [whole, local, domain] = match
      if (PLACEHOLDER_DOMAINS.has(domain.toLowerCase())) return true
      if (IMPERSONAL_LOCAL.test(local)) return true
      /* `@2x` is the retina asset convention, so the "domain" is really a
         filename — which means it has to look like one, anchored at both ends.
         As a prefix match this sanctioned every domain that merely *starts*
         with a retina suffix, so an address at `2x.` anything was exempt. */
      if (/^[0-9]+x\.(?:png|jpe?g|gif|webp|avif)$/i.test(domain)) return true
      /* The userinfo of a URL — a scheme, then credentials, then the host to
         reach — names no mailbox. What is sanctioned is exactly that shape: a
         scheme name, `://`, and then only the characters a URL authority may
         carry before the `@`. An allowlist, for the same reason the rosters
         above are one — a mailbox and a userinfo are spelled alike, so the only
         way to separate them is to say which spelling is which.

         It read `:\/\/[^\s"'`]*$` until round 2 of #278, which asked only that
         some `://` sit behind the address with no space or quote between. Prose
         and spaced table cells did refuse, and that much was worth confirming;
         but the unbroken run was free to contain `/`, `?`, `#`, `|`, `)` and
         `+`, so a mailbox further along the same token rode the earlier scheme
         — a query parameter, a path segment, a fragment, a `file:///` path, a
         pipe table with no spaces, a Markdown link glued to an address. An
         authority ends at the first `/`, `?` or `#`; a run that reaches the `@`
         through one of those is not the userinfo, it is something later in the
         URL. Both seats proposed narrowing by excluding punctuation, and each
         list missed shapes the other caught — `|` and `)`, or `?` and `#` on a
         URL with no path — which is the argument for naming what may appear
         instead of guessing what may not. This arm carries eight lines in the
         tree; all eight still pass it. */
      if (/[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~%+:-]*$/i.test(line.slice(0, match.index))) return true
      /* An scp-style remote: a sanctioned host, then `:`, then a path. The
         remainder has to be path-shaped and unbroken, and the host has to be
         one of the forges above.

         This was a bare `^[:/]` on the next character, which excused a clause
         (`…@host: the notes`), a port (`…@host:443`), a smiley (`…@host:)`)
         and any trailing path (`…@host/path`) — the gate's one job given away
         by four characters, found by all three seats in round 1 of #278. A
         leading port is refused along with them: digits before the slash are a
         URL authority that lost its scheme, not a remote's path.

         The shape alone still left two false greens, named in round 2: an
         address with a relative path after the colon, and one with an absolute
         path, neither of which needs a space the way prose does — a fixture, a
         YAML value or a table cell need not put one there. Nothing in the shape
         can refuse those without also refusing a real remote, so the host
         decides instead. Measured over the tree: three lines reach this
         arm, and all three are this gate's own fixtures — every remote written
         anywhere else says `git@`, which the service-local rule excuses first.
         Requiring a known forge therefore costs nothing the tree writes today,
         and closes both shapes. */
      const pathShaped = /^:(?!\d+\/)[A-Za-z0-9_.~-]*\/[^\s]/.test(line.slice(match.index + whole.length))
      return pathShaped && CODE_HOSTS.has(domain.toLowerCase())
    },
  },
  {
    label: 'a home directory that is not a declared placeholder (AGENTS.md rule 13)',
    /* Anchored the way `check-claims.mjs` anchors its scrub, and for the same
       reason: unanchored, it reads the path of any URL carrying `/home`. A home
       directory starts a path, so it follows the start of the line, whitespace,
       a quote, an opening bracket, a comma, an equals, the colon separating two
       entries of a PATH, or a `file://`. `/var/home` is where Fedora
       Silverblue and SteamOS put one. */
    pattern: /(?<=^|[\s"'`(=\[,:]|file:\/\/)(?:\/var)?\/(?:Users|home)\/([^/\s"'`,)\]]+)/g,
    exempt: (match) => {
      const segment = match[1] ?? ''
      // A dotfile directory under a bare home root is not a person's login name.
      if (segment.startsWith('.')) return true
      /* A segment that is not a name: an ellipsis where the writer elided one,
         or an angle-bracket placeholder standing in for it. Both are the
         opposite of a leak, and the tree writes them in prose *about* home
         paths — including in the screenshot audit whose whole job is finding
         real ones. Found by this rule's first run, which is what #204 expected
         a first run to be for. */
      if (/[…<>]/.test(segment)) return true
      return PLACEHOLDER_HOMES.has(segment.toLowerCase())
    },
  },
]

/**
 * A file whose entire contents are one opaque string is a stored credential.
 *
 * No line pattern can see this: there is no name beside the value to key on,
 * because the filename *is* the name. `.last-token` held sixty-four hex
 * characters and nothing else, and every named-shape rule read straight past
 * it. Source files do not look like this; secret files do.
 */
const isBareCredentialFile = (content) => {
  const value = content.trim()
  if (!/^[A-Za-z0-9+/=_-]{32,}$/.test(value)) return false
  return entropyPerChar(value) >= 3
}

/** Binary and generated content where these shapes appear legitimately. */
const SKIP = /\.(png|jpg|jpeg|gif|ico|icns|woff2?|ttf|lock|lockb)$|pnpm-lock\.yaml$/

/**
 * Every offender in one file's contents, as the line the report prints.
 *
 * Exported, and the walk below guarded, because rules nothing can reach from a
 * test are rules nothing holds — and two of them now decide what counts as a
 * placeholder, which is a judgement worth pinning. Importing this file must
 * therefore not *be* the scan: same guard as `check-layering.mjs`.
 */
export const offendersIn = (file, content) => {
  if (isBareCredentialFile(content)) {
    return [`${file}:1  [file is nothing but a credential]  ${content.trim().slice(0, 12)}…`]
  }
  const offenders = []
  content.split('\n').forEach((line, index) => {
    if (line.includes('hd-secrets-ok')) return
    for (const { label, pattern, minEntropy, exempt } of PATTERNS) {
      /* Every match on the line, not only the first, for any rule that can
         excuse one. A line carrying a git remote's userinfo *and* a real
         address would otherwise be excused by the remote, and the address
         beside it never looked at. */
      const candidates = pattern.global ? [...line.matchAll(pattern)] : [pattern.exec(line)]
      const found = candidates.find((match) => {
        if (match == null) return false
        // A rule that captures its value gets to ask whether the value is random.
        if (minEntropy !== undefined && !looksGenerated(match[1] ?? match[0], minEntropy)) return false
        return exempt === undefined || !exempt(match, line)
      })
      if (found === undefined) continue
      offenders.push(`${file}:${index + 1}  [${label}]  ${line.trim().slice(0, 80)}`)
      return
    }
  })
  return offenders
}

/* Both sides through realpath: `import.meta.url` is always resolved through
   symlinks and `process.argv[1]` is whatever was typed, so comparing them any
   other way disables the command through a link, silently, at exit 0. */
const isMain =
  process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.length > 0 && !SKIP.test(file))

  const offenders = []
  for (const file of files) {
    let content
    try {
      content = readFileSync(resolve(root, file), 'utf8')
    } catch {
      continue
    }
    offenders.push(...offendersIn(file, content))
  }

  if (offenders.length > 0) {
    console.error('Possible secrets tracked by git:\n')
    for (const line of offenders) console.error(`  ${line}`)
    console.error(
      '\nRotate anything real, remove it from history, and load secrets from the' +
        ' environment or the credential broker. A deliberate lookalike can be' +
        ' suppressed with hd-secrets-ok on the same line — a file that is nothing' +
        ' but a credential has no such line, so give it a header or a comment and' +
        ' the ordinary rules apply.\n' +
        '\nAn address or a home directory is rule 13: use a placeholder, or add the' +
        ' stand-in to PLACEHOLDER_DOMAINS or PLACEHOLDER_HOMES in' +
        ' script/check-secrets.mjs with the others. An scp-style remote at a forge' +
        ' this project does not already push to goes in CODE_HOSTS beside them.\n',
    )
    process.exit(1)
  }
  console.log(`No tracked secrets (${files.length} files scanned).`)
}
