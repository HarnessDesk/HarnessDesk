import assert from 'node:assert/strict'
import test from 'node:test'

import { assessCheckRuns, landSafe, REQUIRED_CHECKS } from './land-safe.mjs'

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
