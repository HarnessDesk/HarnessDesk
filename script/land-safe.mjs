#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Required jobs from .github/workflows/ci.yml.
export const REQUIRED_CHECKS = Object.freeze([
  'Build, typecheck, test',
  'UI system browser integration',
  'UI system native integration',
])
const REQUIRED_CHECK_APP = 'github-actions'

const usage = 'Usage: node script/land-safe.mjs <pr> [--repo owner/name] [--dry-run]'

const cliRunner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

const readJsonLines = (raw) => {
  const text = String(raw ?? '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  }
}

// A run that has not started has no `started_at`, and it is the latest attempt
// there is: a rerun still queued must hide the older success it is about to
// replace, never sit behind it (it used to sort as the oldest, so a queued
// rerun next to an older success read as green). A run without a start time is
// newer than any run with one, and the id settles runs that tie.
const newestFirst = (a, b) => {
  const aStarted = a.started_at ?? null
  const bStarted = b.started_at ?? null
  if (aStarted === null && bStarted !== null) return -1
  if (aStarted !== null && bStarted === null) return 1
  if (aStarted !== null && bStarted !== null) {
    const time = String(bStarted).localeCompare(String(aStarted))
    if (time !== 0) return time
  }
  return Number(b.id ?? 0) - Number(a.id ?? 0)
}

/** Pure check-run decision. Only the newest run of each name is considered. */
export const assessCheckRuns = (checkRuns, headSha, requiredNames = REQUIRED_CHECKS) => {
  const newest = new Map()
  for (const check of checkRuns) {
    if (check.head_sha !== headSha || check.app?.slug !== REQUIRED_CHECK_APP) continue
    const current = newest.get(check.name)
    if (!current || newestFirst(check, current) < 0) newest.set(check.name, check)
  }
  const required = requiredNames.map((name) => {
    const check = newest.get(name)
    const green = check?.status === 'completed' && check?.conclusion === 'success'
    return { name, check, green }
  })
  return { green: required.every(({ green }) => green), required, newest }
}

const run = (runner, args) => String(runner(args) ?? '').trim()

const readPr = (runner, pr, repo) => {
  const args = ['pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,state,isDraft,mergeCommit']
  if (repo) args.push('--repo', repo)
  return JSON.parse(run(runner, args))
}

const readBaseTip = (runner, repo, branch) => {
  const encodedBranch = encodeURIComponent(branch)
  return run(runner, ['api', `repos/${repo}/branches/${encodedBranch}`, '--jq', '.commit.sha'])
}

const readCheckRuns = (runner, repo, sha) =>
  readJsonLines(
    run(runner, [
      'api',
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      '--paginate',
      '--jq',
      '.check_runs[]',
    ]),
  )

const write = (stream, message) => stream.write(`${message}\n`)

const printReport = (io, decision) => {
  write(io.stdout, 'CHECK                                      STATUS     CONCLUSION  REQUIRED')
  for (const [name, check] of decision.newest) {
    const required = decision.required.some((entry) => entry.name === name)
    write(
      io.stdout,
      `${name.padEnd(42)} ${(check.status ?? 'missing').padEnd(10)} ${String(check.conclusion ?? '—').padEnd(11)} ${required ? 'yes' : 'no'}`,
    )
  }
  for (const entry of decision.required) {
    if (!entry.check) write(io.stdout, `${entry.name.padEnd(42)} ${'missing'.padEnd(10)} ${'—'.padEnd(11)} yes`)
  }
}

/** Execute the guarded landing flow using an injectable gh-compatible runner. */
export const landSafe = async (
  { pr, repo, dryRun = false },
  runner = cliRunner,
  io = { stdout: process.stdout, stderr: process.stderr },
) => {
  // Once `gh pr merge` has been asked, "was not merged" is no longer something
  // an error can honestly say: the merge may have gone through.
  let mergeAsked = false
  try {
    if (!repo) repo = run(runner, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    const initial = readPr(runner, pr, repo)
    if (initial.isDraft) throw new Error(`PR ${pr} is a draft; refusing to land`)
    if (initial.state !== 'OPEN') throw new Error(`PR ${pr} is ${String(initial.state).toLowerCase()}, not open`)
    const sha = initial.headRefOid
    if (!sha || !initial.baseRefName) throw new Error('GitHub did not return the PR head SHA and base branch')

    const baseTip = readBaseTip(runner, repo, initial.baseRefName)
    const decision = assessCheckRuns(readCheckRuns(runner, repo, sha), sha)
    printReport(io, decision)
    if (!decision.green) {
      write(io.stdout, `DECISION: not green; PR ${pr} was not merged.`)
      return 2
    }

    const current = readPr(runner, pr, repo)
    if (current.isDraft) throw new Error(`PR ${pr} became a draft; refusing to land`)
    if (current.state !== 'OPEN') throw new Error(`PR ${pr} is ${String(current.state).toLowerCase()}, not open`)
    if (current.headRefOid !== sha) {
      write(io.stdout, `DECISION: head moved from ${sha} to ${current.headRefOid}; re-run.`)
      return 3
    }
    if (current.baseRefName !== initial.baseRefName) {
      write(io.stdout, `DECISION: base moved from ${initial.baseRefName} to ${current.baseRefName}; re-run.`)
      return 3
    }
    const currentBaseTip = readBaseTip(runner, repo, initial.baseRefName)
    if (currentBaseTip !== baseTip) {
      write(io.stdout, `DECISION: base ${initial.baseRefName} moved from ${baseTip} to ${currentBaseTip}; re-run.`)
      return 3
    }

    if (dryRun) {
      write(io.stdout, `DECISION: green at ${sha}; dry run, PR ${pr} was not merged.`)
      return 0
    }
    mergeAsked = true
    run(runner, ['pr', 'merge', String(pr), '--repo', repo, '--squash', '--match-head-commit', sha])
    const afterMerge = readPr(runner, pr, repo)
    if (afterMerge.state === 'MERGED' && afterMerge.mergeCommit?.oid) {
      write(io.stdout, `DECISION: merged PR ${pr} at ${sha}; merge commit ${afterMerge.mergeCommit.oid}.`)
      return 0
    }
    if (afterMerge.state === 'OPEN') {
      write(io.stdout, `DECISION: queued PR ${pr}; it has not merged yet.`)
      return 4
    }
    throw new Error(`merge was not confirmed for PR ${pr}: state ${afterMerge.state ?? 'unknown'}, merge commit ${afterMerge.mergeCommit?.oid ?? 'missing'}`)
  } catch (error) {
    write(io.stderr, `land-safe: ${error instanceof Error ? error.message : String(error)}`)
    write(
      io.stdout,
      mergeAsked
        ? `DECISION: error; the merge of PR ${pr} was asked for and is not confirmed; check the PR before anything else.`
        : `DECISION: error; PR ${pr} was not merged.`,
    )
    return 1
  }
}

export const parseArgs = (argv) => {
  const [pr, ...rest] = argv
  if (!pr || !/^\d+$/.test(pr)) throw new Error(usage)
  let repo
  let dryRun = false
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--dry-run' && !dryRun) dryRun = true
    else if (rest[i] === '--repo' && !repo && rest[i + 1] && /^[^/]+\/[^/]+$/.test(rest[i + 1])) repo = rest[++i]
    else throw new Error(usage)
  }
  return { pr, repo, dryRun }
}

export const isEntryPoint = (metaUrl, argv1) => {
  if (argv1 == null) return false
  let modulePath
  try {
    modulePath = realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
  let argvPath
  try {
    argvPath = realpathSync(argv1)
  } catch {
    argvPath = resolve(argv1)
  }
  return modulePath === argvPath
}

const isMain = isEntryPoint(import.meta.url, process.argv[1])
if (isMain) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.stdout.write('DECISION: error; nothing was merged.\n')
    process.exitCode = 1
  }
  if (options) process.exitCode = await landSafe(options)
}
