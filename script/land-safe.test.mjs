import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { assessCheckRuns, isEntryPoint, landSafe, REQUIRED_CHECKS } from './land-safe.mjs'

const scriptPath = fileURLToPath(new URL('./land-safe.mjs', import.meta.url))

const withCliFixture = (callback) => {
  const directory = mkdtempSync(join(tmpdir(), 'land-safe-test-'))
  try {
    const bin = join(directory, 'bin')
    const command = join(bin, 'gh')
    const scriptLink = join(directory, 'land-safe.mjs')
    const directoryLink = join(directory, 'script-link')
    const fakeGh = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (process.env.LAND_SAFE_FAKE_ERROR === '1') {
  process.stderr.write('fake gh failure\\n')
  process.exit(9)
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ headRefOid: 'head-sha', baseRefName: 'main', state: 'OPEN', isDraft: false, mergeCommit: { oid: 'merge-sha' } }))
} else if (args[0] === 'api' && args[1].includes('/branches/')) {
  process.stdout.write('base-sha')
} else if (args[0] === 'api' && args[1].includes('/check-runs')) {
  const checks = ${JSON.stringify(REQUIRED_CHECKS)}.map((name, index) => ({ id: index + 1, name, started_at: '2026-09-30T12:00:00Z', head_sha: 'head-sha', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }))
  if (process.env.LAND_SAFE_FAKE_RED === '1') checks[0].status = 'in_progress'
  process.stdout.write(checks.map(JSON.stringify).join('\\n'))
}
`
    mkdirSync(bin)
    writeFileSync(command, fakeGh)
    chmodSync(command, 0o755)
    symlinkSync(scriptPath, scriptLink)
    symlinkSync(resolve(scriptPath, '..'), directoryLink, 'dir')
    callback({ directory, scriptLink, directoryLink, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const runCli = (script, args = [], env = process.env) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env })

const decisionLines = (stdout) => stdout.split(/\r?\n/).filter((line) => line.startsWith('DECISION:'))

test('symlinked entry paths run the CLI and refuse a pending check', () => {
  withCliFixture(({ scriptLink, directoryLink, env }) => {
    for (const script of [scriptLink, join(directoryLink, 'land-safe.mjs')]) {
      const result = runCli(script, ['42', '--repo', 'acme/widgets'], { ...env, LAND_SAFE_FAKE_RED: '1' })
      assert.equal(result.status, 2, result.stderr)
      assert.equal(decisionLines(result.stdout).length, 1, result.stdout)
      assert.match(result.stdout, /DECISION: not green; PR 42 was not merged\./)
    }
  })
})

test('a symlinked entry path reports a green dry run', () => {
  withCliFixture(({ scriptLink, env }) => {
    const result = runCli(scriptLink, ['42', '--repo', 'acme/widgets', '--dry-run'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(decisionLines(result.stdout).length, 1, result.stdout)
    assert.match(result.stdout, /DECISION: green at head-sha; dry run, PR 42 was not merged\./)
  })
})

test('bad arguments through a symlink print an error decision and fail', () => {
  withCliFixture(({ scriptLink, env }) => {
    const result = runCli(scriptLink, [], env)
    assert.equal(result.status, 1)
    assert.equal(decisionLines(result.stdout).length, 1, result.stdout)
    assert.equal(decisionLines(result.stdout)[0], 'DECISION: error; nothing was merged.')
  })
})

test('a landing error through a symlink prints one PR error decision and fails', () => {
  withCliFixture(({ scriptLink, env }) => {
    const result = runCli(scriptLink, ['42', '--repo', 'acme/widgets'], { ...env, LAND_SAFE_FAKE_ERROR: '1' })
    assert.equal(result.status, 1)
    assert.equal(decisionLines(result.stdout).length, 1, result.stdout)
    assert.equal(decisionLines(result.stdout)[0], 'DECISION: error; PR 42 was not merged.')
    assert.match(result.stderr, /land-safe: Command failed/)
  })
})

test('importing the module does not run the CLI', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(new URL('./land-safe.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('entry-point detection canonicalizes symlinked argv paths', () => {
  withCliFixture(({ scriptLink }) => {
    assert.equal(isEntryPoint(new URL('./land-safe.mjs', import.meta.url).href, scriptLink), true)
    assert.equal(isEntryPoint(new URL('./land-safe.mjs', import.meta.url).href, undefined), false)
    assert.equal(isEntryPoint(new URL('./land-safe.mjs', import.meta.url).href, join(tmpdir(), 'unrelated.mjs')), false)
  })
})

const good = (name, overrides = {}) => ({
  id: 1,
  name,
  started_at: '2026-09-30T12:00:00Z',
  head_sha: 'head-sha',
  app: { slug: 'github-actions' },
  status: 'completed',
  conclusion: 'success',
  ...overrides,
})

const checksGreen = () => REQUIRED_CHECKS.map((name, index) => good(name, { id: index + 1 }))

const harness = ({
  checks = checksGreen(),
  heads = ['head-sha', 'head-sha', 'head-sha'],
  baseTips = ['base-sha', 'base-sha'],
  prStates = ['OPEN', 'OPEN', 'MERGED'],
  drafts = [false, false, false],
  mergeCommit = 'merge-sha',
  mergeOutput = '',
} = {}) => {
  const calls = []
  let prViews = 0
  let baseReads = 0
  const runner = (args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'view') {
      const index = Math.min(prViews, heads.length - 1)
      const headRefOid = heads[index]
      const state = prStates[Math.min(prViews, prStates.length - 1)]
      const isDraft = drafts[Math.min(prViews, drafts.length - 1)]
      prViews += 1
      return JSON.stringify({ headRefOid, baseRefName: 'main', state, isDraft, mergeCommit: { oid: mergeCommit } })
    }
    if (args[0] === 'api' && args[1].includes('/branches/')) {
      const tip = baseTips[Math.min(baseReads, baseTips.length - 1)]
      baseReads += 1
      return tip
    }
    if (args[0] === 'api') {
      return checks.map((check) => JSON.stringify(check)).join('\n')
    }
    return mergeOutput
  }
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  }
  return { calls, runner, io, output: () => ({ stdout, stderr }) }
}

test('all required checks green merges against the SHA read from the PR', async () => {
  const h = harness()
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--match-head-commit') && args.at(-1) === 'head-sha'))
  assert.match(h.output().stdout, /DECISION: merged PR 42 at head-sha/)
})

test('a newer success supersedes an old failed run with the same name', () => {
  const checks = [
    good('Build, typecheck, test', { id: 1, started_at: '2026-09-30T11:00:00Z', conclusion: 'failure' }),
    good('Build, typecheck, test', { id: 2, started_at: '2026-09-30T12:00:00Z' }),
    ...checksGreen().slice(1),
  ]
  assert.equal(assessCheckRuns(checks, 'head-sha').green, true)
})

test('a queued rerun with no start time is not green, however it is listed beside an older success', () => {
  const older = good('Build, typecheck, test', { id: 1, started_at: '2026-09-30T11:00:00Z' })
  const queued = good('Build, typecheck, test', { id: 2, started_at: null, status: 'queued', conclusion: null })
  for (const runs of [[older, queued], [queued, older]]) {
    const decision = assessCheckRuns([...runs, ...checksGreen().slice(1)], 'head-sha')
    assert.equal(decision.green, false)
    assert.equal(decision.newest.get('Build, typecheck, test').status, 'queued')
  }
})

test('between two runs that have not started, the higher id is the newest', () => {
  const finished = good('Build, typecheck, test', { id: 3, started_at: null })
  const queued = good('Build, typecheck, test', { id: 4, started_at: null, status: 'queued', conclusion: null })
  assert.equal(assessCheckRuns([finished, queued, ...checksGreen().slice(1)], 'head-sha').green, false)
  assert.equal(assessCheckRuns([queued, { ...finished, id: 5 }, ...checksGreen().slice(1)], 'head-sha').green, true)
})

test('a newer failure supersedes an old success with the same name', () => {
  const checks = [
    good('Build, typecheck, test', { id: 1, started_at: '2026-09-30T11:00:00Z' }),
    good('Build, typecheck, test', { id: 2, started_at: '2026-09-30T12:00:00Z', conclusion: 'failure' }),
    ...checksGreen().slice(1),
  ]
  assert.equal(assessCheckRuns(checks, 'head-sha').green, false)
})

test('same-name success from another app is not green', () => {
  const checks = checksGreen()
  checks[0] = good(REQUIRED_CHECKS[0], { app: { slug: 'other-app' } })
  assert.equal(assessCheckRuns(checks, 'head-sha').green, false)
})

test('check run for another head SHA is ignored', () => {
  const checks = checksGreen()
  checks[0] = good(REQUIRED_CHECKS[0], { head_sha: 'other-head' })
  assert.equal(assessCheckRuns(checks, 'head-sha').green, false)
})

test('equal start times use the higher run id as the tie-breaker', () => {
  const checks = [
    good(REQUIRED_CHECKS[0], { id: 10, conclusion: 'failure' }),
    good(REQUIRED_CHECKS[0], { id: 11 }),
    ...checksGreen().slice(1),
  ]
  assert.equal(assessCheckRuns(checks, 'head-sha').green, true)
})

for (const [label, overrides] of [
  ['pending', { status: 'pending', conclusion: null }],
  ['queued', { status: 'queued', conclusion: null }],
  ['in progress', { status: 'in_progress', conclusion: null }],
  ['cancelled', { conclusion: 'cancelled' }],
  ['skipped', { conclusion: 'skipped' }],
]) {
  test(`${label} required check is not green`, () => {
    const checks = checksGreen()
    checks[0] = good(REQUIRED_CHECKS[0], overrides)
    assert.equal(assessCheckRuns(checks, 'head-sha').green, false)
  })
}

test('a missing required check is not green', () => {
  assert.equal(assessCheckRuns(checksGreen().slice(1), 'head-sha').green, false)
})

test('head movement after checks exits 3 without a merge call', async () => {
  const h = harness({ heads: ['head-sha', 'new-head-sha'] })
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 3)
  assert.equal(h.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false)
  assert.match(h.output().stdout, /head moved from head-sha to new-head-sha/)
})

test('base branch tip movement after checks exits 3 without a merge call', async () => {
  const h = harness({ baseTips: ['base-sha', 'new-base-sha'] })
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 3)
  assert.equal(h.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false)
  assert.match(h.output().stdout, /base main moved from base-sha to new-base-sha/)
})

test('check-runs are requested only for the PR head SHA', async () => {
  const h = harness()
  await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  const checkCall = h.calls.find((args) => args[0] === 'api' && args[1].includes('/check-runs'))
  assert.equal(checkCall[1], 'repos/owner/repo/commits/head-sha/check-runs?per_page=100')
  assert.ok(checkCall.includes('--paginate'))
  assert.equal(h.calls.some((args) => args[0] === 'pr' && args[1] === 'checks'), false)
})

test('--dry-run reports green without calling merge', async () => {
  const h = harness()
  const code = await landSafe({ pr: '42', repo: 'owner/repo', dryRun: true }, h.runner, h.io)
  assert.equal(code, 0)
  assert.equal(h.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false)
  assert.match(h.output().stdout, /dry run/)
})

test('draft PR is refused before check assessment', async () => {
  const h = harness({ drafts: [true] })
  const code = await landSafe({ pr: '42', repo: 'owner/repo', dryRun: true }, h.runner, h.io)
  assert.equal(code, 1)
  assert.equal(h.calls.some((args) => args[0] === 'api' && args[1].includes('/check-runs')), false)
  assert.match(h.output().stderr, /PR 42 is a draft/)
})

for (const state of ['CLOSED', 'MERGED']) {
  test(`${state.toLowerCase()} PR is refused before check assessment`, async () => {
    const h = harness({ prStates: [state] })
    const code = await landSafe({ pr: '42', repo: 'owner/repo', dryRun: true }, h.runner, h.io)
    assert.equal(code, 1)
    assert.equal(h.calls.some((args) => args[0] === 'api' && args[1].includes('/check-runs')), false)
    assert.match(h.output().stderr, new RegExp(`PR 42 is ${state.toLowerCase()}`))
  })
}

test('merge queue is reported with exit 4 and not as merged', async () => {
  const h = harness({ prStates: ['OPEN', 'OPEN', 'OPEN'], mergeOutput: 'Added to merge queue' })
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 4)
  assert.match(h.output().stdout, /DECISION: queued PR 42/)
  assert.doesNotMatch(h.output().stdout, /DECISION: merged PR/)
  assert.equal(h.calls.filter((args) => args[0] === 'pr' && args[1] === 'view').length, 3)
})

test('merge is reported only after fresh PR state includes the merge commit', async () => {
  const h = harness({ prStates: ['OPEN', 'OPEN', 'MERGED'], mergeCommit: 'confirmed-merge-sha' })
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.match(h.output().stdout, /DECISION: merged PR 42 at head-sha; merge commit confirmed-merge-sha/)
  assert.equal(h.calls.filter((args) => args[0] === 'pr' && args[1] === 'view').length, 3)
})

test('an unconfirmed merge never says the PR was not merged', async () => {
  const h = harness({ prStates: ['OPEN', 'OPEN', 'CLOSED'] })
  const code = await landSafe({ pr: '42', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 1)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'))
  const { stdout, stderr } = h.output()
  assert.match(stdout, /DECISION: error; the merge of PR 42 was asked for and is not confirmed/)
  assert.doesNotMatch(stdout, /was not merged/)
  assert.match(stderr, /merge was not confirmed for PR 42/)
})
