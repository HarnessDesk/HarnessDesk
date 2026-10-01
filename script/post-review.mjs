#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLACEHOLDER_EMAIL_DOMAINS = Object.freeze(['example.com', 'acme.dev', 'harnessdesk.app'])

const usage = 'Usage: node script/post-review.mjs <pr> --round <n> --by "<model effort>" [--file <result.md> | stdin] [--repo owner/name] [--dry-run] | node script/post-review.mjs <pr> --fixes <file> [--repo owner/name] [--dry-run]'

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

const cliRunner = (args, body) => {
  if (body == null) return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const directory = mkdtempSync(join(tmpdir(), 'harnessdesk-review-'))
  const bodyFile = join(directory, 'body.md')
  try {
    writeFileSync(bodyFile, body, { encoding: 'utf8', mode: 0o600 })
    const command = [...args, '--body-file', bodyFile]
    return execFileSync('gh', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const run = (runner, args, body) => String(runner(args, body) ?? '').trim()

const namedEntities = Object.freeze({
  amp: '&', commat: '@', sol: '/', bsol: '\\', colon: ':', period: '.', num: '#',
  lowbar: '_', percnt: '%', plus: '+', dash: '-', hyphen: '-', tilde: '~',
})

const codePoint = (value, radix = 10) => {
  const number = Number.parseInt(value, radix)
  return Number.isInteger(number) && number >= 0 && number <= 0x10ffff
    ? String.fromCodePoint(number)
    : null
}

/** Zero-width, bidi-control, joiner and soft-hyphen characters, plus the BOM. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g

const decodePrivateText = (value) => {
  let text = String(value ?? '')
  for (let pass = 0; pass < 64; pass += 1) {
    const before = text
    text = text.replace(/%([\da-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    text = text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi, (entity, decimal, hex, name) => {
      if (decimal) return codePoint(decimal) ?? entity
      if (hex) return codePoint(hex, 16) ?? entity
      return namedEntities[name.toLowerCase()] ?? entity
    })
    text = text.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (escape, braced, unicode, byte) => {
      return codePoint(braced ?? unicode ?? byte, 16) ?? escape
    })
    // Characters that draw nothing can hide a path from a pattern (a zero-width space inside "Users").
    text = text.replace(INVISIBLE, '')
    if (text === before) return { text, stable: true }
  }
  return { text, stable: false }
}

/** Rewrite known HarnessDesk checkout roots, then redact any other local path. */
const scrubLocalPaths = (input) => {
  let text = input
  const roots = [
    /(?:\/Users\/[^/]+\/(?:[^/]+\/)*?|\/home\/[^/]+\/(?:[^/]+\/)*?)HarnessDesk-worktrees\/[^/]+\//g,
    /(?:\/Users\/[^/]+\/(?:[^/]+\/)*?|\/home\/[^/]+\/(?:[^/]+\/)*?)HarnessDesk\//g,
  ]
  for (const root of roots) text = text.replace(root, '')

  return text
    .replace(/\bfile:\/\/[^\s)\]}>'"`]+/gi, '<local path>')
    .replace(/~[^/\s]*\/[^\s)\]}>'"`]+/g, '<local path>')
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\s)\]}>'"`]+/gi, '<local path>')
    .replace(/(?<![\\\w])\\{2,}[\w.$-]{2,}\\+[^\s)\]}>'"`]+/g, '<local path>')
    .replace(/\/Users\/[^\s)\]}>"'`]+/g, '<local path>')
    .replace(/\/home\/[^\s)\]}>"'`]+/g, '<local path>')
    .replace(/\/private\/[^\s)\]}>"'`]+/g, '<local path>')
    .replace(/\/(?:tmp|var\/folders)\/[^\s)\]}>"'`]+/g, '<local path>')
}

export const sanitizeBody = (body) => scrubLocalPaths(decodePrivateText(body).text)

const verdictFrom = (text) => {
  const match = String(text).match(/^\s*Verdict:\s*([^\r\n]*)/im)
  return match ? (match[1].trim().replace(/[.\s]+$/, '') || 'see below') : 'see below'
}

export const buildReviewBody = (body, round, by) => {
  const sanitized = sanitizeBody(body)
  const verdict = verdictFrom(sanitized)
  return `Review round ${round} · ${by} (via HarnessDesk) · ${verdict}\n\n${sanitized}`
}

const privateLines = (body) => {
  const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi
  const sources = [String(body), decodePrivateText(body).text]
  return [...new Set(sources.flatMap((source) => source.split(/\r?\n/).flatMap((line, index) => {
    const pathIssue = /(?:~[^/\s]*\/|\/Users\/|\/home\/[^/\s]+|\/private\/|\/tmp\/|\/var\/folders\/|\bfile:\/\/|\b[A-Za-z]:[\\/]+Users[\\/]+|(?<![\\\w])\\{2,}[\w.$-]{2,}\\+\S)/i.test(line)
    const emailIssue = [...line.matchAll(emailPattern)].some((match) =>
      !PLACEHOLDER_EMAIL_DOMAINS.includes(match[1].toLowerCase()),
    )
    return pathIssue || emailIssue ? [`${index + 1}: ${line}`] : []
  })))]
}

const withRepo = (args, repo) => repo ? [...args, '--repo', repo] : args

const readIdentity = (runner, pr, repo) => {
  const authorArgs = withRepo(['pr', 'view', String(pr), '--json', 'author', '--jq', '.author.login'], repo)
  const viewerArgs = ['api', 'user', '--jq', '.login']
  return { author: run(runner, authorArgs), viewer: run(runner, viewerArgs) }
}

const printDryRun = (io, body, command) => {
  io.stdout.write(`${body}\n\n${command.map(shellQuote).join(' ')} --body-file <body-file>\n`)
}

/** Prepare and post a signed review or an unsigned fixes comment. */
export const postReview = async (
  options,
  runner = cliRunner,
  io = { stdout: process.stdout, stderr: process.stderr },
) => {
  try {
    const { pr, repo, dryRun = false } = options
    const fixes = options.fixes != null
    const decoded = decodePrivateText(fixes ? options.fixes : options.body)
    if (!decoded.stable) {
      io.stderr.write('REFUSED: text did not finish decoding safely; nothing was posted.\n')
      return 2
    }
    const body = fixes ? sanitizeBody(options.fixes) : buildReviewBody(options.body, options.round, options.by)
    const offenders = privateLines(body)
    if (offenders.length) {
      for (const line of offenders) io.stderr.write(`${line}\n`)
      io.stderr.write('REFUSED: private text remains in the sanitized post; nothing was posted.\n')
      return 2
    }

    let command
    if (fixes) {
      command = withRepo(['pr', 'comment', String(pr)], repo)
    } else {
      const { author, viewer } = readIdentity(runner, pr, repo)
      const isAuthor = author.toLowerCase() === viewer.toLowerCase()
      const verdict = verdictFrom(options.body).toLowerCase().replace(/[\s-]+/g, ' ').trim()
      const flag = isAuthor ? '--comment'
        : verdict === 'changes needed' ? '--request-changes'
          : verdict === 'approve' || verdict === 'approved' ? '--approve' : '--comment'
      command = withRepo(['pr', 'review', String(pr), flag], repo)
    }

    if (dryRun) {
      printDryRun(io, body, ['gh', ...command])
      return 0
    }
    run(runner, command, body)
    io.stdout.write(`Posted ${fixes ? 'fixes comment' : 'review'} for PR ${pr}.\n`)
    return 0
  } catch (error) {
    io.stderr.write(`post-review: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export const parseArgs = (argv) => {
  const [pr, ...rest] = argv
  if (!pr || !/^\d+$/.test(pr)) throw new Error(usage)
  let round
  let by
  let file
  let fixesFile
  let repo
  let dryRun = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--round' && round == null && value && /^\d+$/.test(value) && Number(value) > 0) round = value, i += 1
    else if (flag === '--by' && by == null && value && !value.startsWith('--')) by = value, i += 1
    else if (flag === '--file' && file == null && value && !value.startsWith('--')) file = value, i += 1
    else if (flag === '--fixes' && fixesFile == null && value && !value.startsWith('--')) fixesFile = value, i += 1
    else if (flag === '--repo' && repo == null && value && /^[^/]+\/[^/]+$/.test(value)) repo = value, i += 1
    else if (flag === '--dry-run' && !dryRun) dryRun = true
    else throw new Error(usage)
  }
  if (fixesFile) {
    if (round || by || file) throw new Error(usage)
    return { pr, fixesFile, repo, dryRun }
  }
  if (!round || !by) throw new Error(usage)
  return { pr, round, by, file, repo, dryRun }
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.fixesFile) options.fixes = readFileSync(options.fixesFile, 'utf8')
    else options.body = options.file ? readFileSync(options.file, 'utf8') : readFileSync(0, 'utf8')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
  process.exitCode = await postReview(options)
}
