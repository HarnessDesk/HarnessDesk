import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildReviewBody,
  parseArgs,
  postReview,
  sanitizeBody,
} from './post-review.mjs'

test('signs a review with the first verdict line, or see below when absent', () => {
  assert.equal(buildReviewBody('Verdict: Changes Needed\nDetails', 3, 'Codex GPT-6'),
    'Review round 3 · Codex GPT-6 (via HarnessDesk) · Changes Needed\n\nVerdict: Changes Needed\nDetails')
  assert.equal(buildReviewBody('No verdict', 1, 'Codex'),
    'Review round 1 · Codex (via HarnessDesk) · see below\n\nNo verdict')
})

test('rewrites worktree and plain checkout paths in links and plain text', () => {
  const worktree = userPath('code-shane', 'HarnessDesk-worktrees', 'lane-post-review', 'script', 'post-review.mjs')
  const checkout = userPath('code-shane', 'HarnessDesk', 'docs', 'release.md')
  assert.equal(sanitizeBody(`[test](${worktree}) ${worktree}\n[docs](${checkout}) ${checkout}`),
    '[test](script/post-review.mjs) script/post-review.mjs\n[docs](docs/release.md) docs/release.md')
  assert.equal(sanitizeBody(`Temp ${['', 'tmp', 'cache.txt'].join('/')}`), 'Temp <local path>')
})

const realLookingEmail = ['reviewer', 'example.org'].join(String.fromCharCode(64))
for (const value of [
  `Found ${['', 'Users', ''].join('/')}`,
  `Contact ${realLookingEmail}`,
  `Found ${['', 'private', ''].join('/')}`,
  `Found ${['C:', 'Users', ''].join('\\')}`,
]) {
  test(`refuses remaining private value: ${value}`, async () => {
    const h = harness()
    const code = await postReview({ pr: '42', round: '1', by: 'Codex', body: value, repo: 'owner/repo' }, h.runner, h.io)
    assert.equal(code, 2)
    assert.equal(h.calls.some(isPost), false)
    assert.match(h.output().stderr, /REFUSED/)
  })
}

test('placeholder email domains are allowed', async () => {
  const h = harness()
  const code = await postReview({ pr: '42', round: '1', by: 'Codex', body: 'dev@example.com', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.ok(h.calls.some(isPost))
})

test('non-author changes-needed review requests changes', async () => {
  const h = harness()
  const code = await postReview({ pr: '42', round: '1', by: 'Codex', body: 'Verdict: changes needed', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'review' && args.includes('--request-changes')))
})

test('PR author posts changes-needed as a comment with verdict in signed line', async () => {
  const h = harness({ author: 'viewer' })
  const code = await postReview({ pr: '42', round: '1', by: 'Codex', body: 'Verdict: changes needed', repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'review' && args.includes('--comment')))
  assert.match(h.bodies[0], /Review round 1 · Codex \(via HarnessDesk\) · changes needed/)
})

test('PR author cannot approve and falls back to comment', async () => {
  const h = harness({ author: 'viewer' })
  await postReview({ pr: '42', round: '1', by: 'Codex', body: 'Verdict: approve', repo: 'owner/repo' }, h.runner, h.io)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'review' && args.includes('--comment')))
})

test('--dry-run prints the post plan and never calls gh to post', async () => {
  const h = harness()
  const code = await postReview({ pr: '42', round: '2', by: 'Codex', body: 'Verdict: approve', repo: 'owner/repo', dryRun: true }, h.runner, h.io)
  assert.equal(code, 0)
  assert.equal(h.calls.some(isPost), false)
  assert.match(h.output().stdout, /Review round 2 · Codex/)
  assert.match(h.output().stdout, /'gh' 'pr' 'review' '42'.*'--approve'/)
})

test('CLI dry-run handles a clean review through an injected gh runner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'post-review-cli-'))
  try {
    const runnerPath = join(directory, 'gh')
    const reviewPath = join(directory, 'review.md')
    const logPath = join(directory, 'calls.jsonl')
    writeFileSync(reviewPath, 'Verdict: approve\nNo issues found.\n')
    writeFileSync(runnerPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.POST_REVIEW_RUNNER_LOG, JSON.stringify(args) + '\\n')
if (process.env.POST_REVIEW_RUNNER_FAIL) process.exit(91)
if (args[0] === 'pr' && args[1] === 'view') process.stdout.write('contributor\\n')
else if (args[0] === 'api' && args[1] === 'user') process.stdout.write('reviewer\\n')
else process.exit(91)
`)
    chmodSync(runnerPath, 0o755)
    const scriptPath = fileURLToPath(new URL('./post-review.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [scriptPath, '1199', '--round', '1', '--by', 'Codex GPT-6 Luna xhigh', '--file', reviewPath, '--dry-run'], {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, POST_REVIEW_RUNNER_LOG: logPath },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Review round 1 · Codex GPT-6 Luna xhigh/)
    assert.match(result.stdout, /'gh' 'pr' 'review' '1199' '--approve'/)
    assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).map((args) => args.slice(0, 2)), [
      ['pr', 'view'],
      ['api', 'user'],
    ])
    assert.equal(result.stderr, '')

    const failed = spawnSync(process.execPath, [scriptPath, '1199', '--round', '1', '--by', 'Codex', '--file', reviewPath, '--dry-run'], {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, POST_REVIEW_RUNNER_LOG: logPath, POST_REVIEW_RUNNER_FAIL: '1' },
      encoding: 'utf8',
    })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /post-review:/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('--fixes posts an unsigned sanitized comment', async () => {
  const h = harness()
  const path = userPath('code-shane', 'HarnessDesk-worktrees', 'lane', 'docs', 'release.md')
  const code = await postReview({ pr: '42', fixes: `[fixed](${path}) in commit abc123`, repo: 'owner/repo' }, h.runner, h.io)
  assert.equal(code, 0)
  assert.ok(h.calls.some((args) => args[0] === 'pr' && args[1] === 'comment'))
  assert.match(h.bodies[0], /\[fixed\]\(docs\/release.md\) in commit abc123/)
  assert.doesNotMatch(h.output().stdout, /Review round/)
})

test('argument parser accepts review stdin/file and fixes modes', () => {
  assert.deepEqual(parseArgs(['42', '--round', '2', '--by', 'Codex high', '--file', 'result.md']), {
    pr: '42', round: '2', by: 'Codex high', file: 'result.md', repo: undefined, dryRun: false,
  })
  assert.deepEqual(parseArgs(['42', '--fixes', 'fixes.md', '--repo', 'owner/repo']), {
    pr: '42', fixesFile: 'fixes.md', repo: 'owner/repo', dryRun: false,
  })
})

function isPost(args) {
  return args[0] === 'pr' && (args[1] === 'review' || args[1] === 'comment')
}

function userPath(...segments) {
  return `/${['Users', 'sample-user', ...segments].join('/')}`
}

function harness({ author = 'contributor', viewer = 'viewer' } = {}) {
  const calls = []
  const bodies = []
  const runner = (args, body) => {
    calls.push(args)
    if (body != null) bodies.push(body)
    if (args[0] === 'pr' && args[1] === 'view') return author
    if (args[0] === 'api' && args[1] === 'user') return viewer
    return ''
  }
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  }
  return { calls, bodies, runner, io, output: () => ({ stdout, stderr }) }
}
