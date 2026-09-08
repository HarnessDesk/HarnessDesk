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
import { readFileSync } from 'node:fs'
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
  if (isBareCredentialFile(content)) {
    offenders.push(`${file}:1  [file is nothing but a credential]  ${content.trim().slice(0, 12)}…`)
    continue
  }
  const lines = content.split('\n')
  lines.forEach((line, index) => {
    if (line.includes('hd-secrets-ok')) return
    for (const { label, pattern, minEntropy } of PATTERNS) {
      const found = pattern.exec(line)
      if (!found) continue
      // A rule that captures its value gets to ask whether the value is random.
      if (minEntropy !== undefined && !looksGenerated(found[1] ?? found[0], minEntropy)) continue
      offenders.push(`${file}:${index + 1}  [${label}]  ${line.trim().slice(0, 80)}`)
      return
    }
  })
}

if (offenders.length > 0) {
  console.error('Possible secrets tracked by git:\n')
  for (const line of offenders) console.error(`  ${line}`)
  console.error(
    '\nRotate anything real, remove it from history, and load secrets from the' +
      ' environment or the credential broker. A deliberate lookalike can be' +
      ' suppressed with hd-secrets-ok on the same line — a file that is nothing' +
      ' but a credential has no such line, so give it a header or a comment and' +
      ' the ordinary rules apply.\n',
  )
  process.exit(1)
}
console.log(`No tracked secrets (${files.length} files scanned).`)
