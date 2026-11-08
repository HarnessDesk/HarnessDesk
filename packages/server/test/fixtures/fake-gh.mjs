#!/usr/bin/env node
/**
 * A fake `gh`, runnable from `PATH`, for driving Intake against a real,
 * launched HarnessDesk rather than a `node:test` process.
 *
 * It answers exactly the fixed `gh api --method GET` reads
 * `packages/server/src/intake/forge.ts` makes and the `gh repo view` read
 * `packages/server/src/intake/consent.ts` makes — the same shape
 * `packages/server/test/fixtures/intake-forge.ts`'s `FakeForge` answers in
 * process, translated into a spawnable executable so a real Electron app can
 * be pointed at it by putting this file first on `PATH` as `gh`. State lives
 * in one JSON file named by `FAKE_GH_STATE`, so a driving script can seed a
 * pull request or an issue event between polls by editing that file; nothing
 * here touches a network or a real account.
 *
 *   FAKE_GH_STATE=/tmp/state.json fake-gh.mjs repo view --json nameWithOwner,url
 *   FAKE_GH_STATE=/tmp/state.json fake-gh.mjs api --method GET -H 'Accept: ...' user
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const REPO = 'acme/widgets'

const defaultState = () => ({
  repo: REPO,
  view: { nameWithOwner: REPO, url: `https://github.com/${REPO}` },
  user: { id: 7, login: 'jane-doe' },
  pulls: [],
  issues: [],
})

const statePath = process.env['FAKE_GH_STATE']
if (!statePath) {
  process.stderr.write('fake-gh: FAKE_GH_STATE must name a JSON state file\n')
  process.exit(2)
}

const load = () => {
  if (!existsSync(statePath)) {
    const initial = defaultState()
    writeFileSync(statePath, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

const iso = (ms) => new Date(ms).toISOString()

const pullJson = (state, one) => ({
  number: one.number,
  title: one.title ?? `Change ${one.number}`,
  body: one.body ?? null,
  state: one.state,
  merged: one.merged ?? false,
  created_at: iso(one.created),
  updated_at: iso(one.updated),
  html_url: one.url ?? `https://github.com/${state.repo}/pull/${one.number}`,
  head: { sha: one.head, ref: one.branch ?? 'worker', repo: one.headRepo === null ? null : { full_name: one.headRepo ?? state.repo } },
  base: { repo: { full_name: one.baseRepo ?? state.repo } },
})

const answer = (state, path) => {
  if (path === 'user') {
    if (!state.user) {
      const error = new Error('HTTP 401: Bad credentials')
      error.signedOut = true
      throw error
    }
    return state.user
  }
  const url = new URL(`https://api.invalid/${path}`)
  const page = Number(url.searchParams.get('page') ?? '1')
  const per = Number(url.searchParams.get('per_page') ?? '30')
  const slice = (items) => items.slice((page - 1) * per, page * per)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'repos' || `${parts[1]}/${parts[2]}` !== state.repo) {
    throw new Error(`unexpected path ${path}`)
  }
  if (parts[3] === 'rules' && parts[4] === 'branches') return []
  if (parts[3] === 'branches') {
    const name = decodeURIComponent(parts[4])
    return { name, commit: { sha: state.baseTips?.[name] ?? state.publicationHead }, protected: (state.protectedBranches ?? []).includes(name), protection: { enabled: false } }
  }
  if (parts.length === 3) return { squash_merge_commit_message: 'PR_BODY', merge_commit_message: 'PR_TITLE' }
  if (parts[3] === 'pulls' && parts.length === 4) {
    const wantState = url.searchParams.get('state')
    const rows = state.pulls
      .filter((one) => wantState === 'all' || one.state === wantState)
      .sort((a, b) => b.updated - a.updated)
    return slice(rows).map((one) => pullJson(state, one))
  }
  if (parts[3] === 'pulls' && parts.length === 5) {
    const one = state.pulls.find((row) => row.number === Number(parts[4]))
    if (!one) throw new Error('Not Found (HTTP 404)')
    return pullJson(state, one)
  }
  if (parts[3] === 'pulls' && parts[5] === 'reviews') {
    if (parts[6]) return state.pulls.find((row) => row.number === Number(parts[4]))?.reviews?.find((one) => one.id === Number(parts[6]))
    return slice(state.pulls.find((row) => row.number === Number(parts[4]))?.reviews ?? [])
  }
  if (parts[3] === 'commits') {
    const one = state.pulls.find((row) => row.head === parts[4])
    if (parts[5] === 'check-runs') return { total_count: one?.checks?.length ?? 0, check_runs: slice(one?.checks ?? []) }
    if (parts[5] === 'status') return { sha: parts[4], total_count: one?.statuses?.length ?? 0, statuses: slice(one?.statuses ?? []) }
  }
  if (parts[3] === 'collaborators' && parts[5] === 'permission') {
    const one = state.permissions?.[parts[4]]
    if (!one) throw new Error('Not Found (HTTP 404)')
    return { permission: one.permission, role_name: one.permission, user: { id: one.id, login: parts[4] } }
  }
  if (parts[3] === 'issues' && parts.length === 4) {
    const rows = [...state.issues].sort((a, b) => b.updated - a.updated)
    return slice(rows).map((one) => ({
      number: one.number,
      title: one.title ?? `Issue ${one.number}`,
      body: one.body ?? null,
      state: one.state,
      created_at: iso(one.created),
      updated_at: iso(one.updated),
      html_url: `https://github.com/${state.repo}/issues/${one.number}`,
      ...(one.pullRequest ? { pull_request: { url: 'x' } } : {}),
    }))
  }
  if (parts[3] === 'issues' && parts[5] === 'events') {
    const issue = state.issues.find((one) => one.number === Number(parts[4]))
    return slice(issue?.events ?? []).map((one) => ({
      id: one.id,
      event: one.event,
      created_at: iso(one.created),
      ...(one.label !== undefined ? { label: { name: one.label } } : {}),
    }))
  }
  if (parts[3] === 'issues' && parts[5] === 'comments') {
    const since = Date.parse(url.searchParams.get('since') ?? iso(0))
    const issue = state.issues.find((one) => one.number === Number(parts[4]))
    return slice((issue?.comments ?? []).filter((one) => one.updated >= since)).map((one) => ({
      id: one.id,
      body: one.body,
      created_at: iso(one.created),
      updated_at: iso(one.updated),
      html_url: `https://github.com/${state.repo}/issues/${parts[4]}#issuecomment-${one.id}`,
      // Who wrote it: the signed-in account unless the state names someone else, nobody readable when null.
      ...(one.user === null ? {} : { user: one.user ?? state.user }),
    }))
  }
  throw new Error(`unexpected path ${path}`)
}

const args = process.argv.slice(2)
const state = load()
// Opt-in, for a driving script to confirm this file — not a real `gh` this
// machine already has — is the one actually being spawned.
if (process.env['FAKE_GH_TRACE']) {
  try {
    appendFileSync(process.env['FAKE_GH_TRACE'], `${JSON.stringify({ argv: args, cwd: process.cwd(), hasCredential: !!process.env['GH_TOKEN'], envKeys: Object.keys(process.env) })}\n`)
  } catch {
    // best effort only
  }
}

if (args[0] === 'repo' && args[1] === 'view') {
  if (!state.view) {
    process.stderr.write('no git remotes found\n')
    process.exitCode = 1
  } else {
    process.stdout.write(JSON.stringify(state.view))
    process.exitCode = 0
  }
} else if (args[0] === 'pr') {
  const after = (flag) => args[args.indexOf(flag) + 1]
  const pullView = one => ({ number: one.number, title: one.title ?? `Change ${one.number}`, body: one.body ?? '',
    state: one.merged ? 'MERGED' : one.state === 'closed' ? 'CLOSED' : 'OPEN', url: `https://github.com/${state.repo}/pull/${one.number}`,
    baseRefName: one.base ?? 'main', baseRefOid: state.baseTips?.[one.base ?? 'main'] ?? state.publicationHead, headRefName: one.branch ?? 'worker', headRefOid: one.head, isCrossRepository: false, headRepositoryOwner: { login: state.repo.split('/')[0] }, author: { login: state.user?.login ?? 'demo' } })
  if (args[1] === 'list') {
    process.stdout.write(JSON.stringify(state.pulls.filter(one => one.state === 'open' && (!args.includes('--head') || one.branch === after('--head'))).map(pullView)))
  } else if (args[1] === 'create') {
    const head = state.publicationHead ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const number = Math.max(0, ...state.pulls.map(one => one.number)) + 1, now = Date.now()
    state.pulls.push({ number, head, branch: after('--head'), state: 'open', title: after('--title'), body: after('--body'), base: args.includes('--base') ? after('--base') : 'main', created: now, updated: now })
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    process.stdout.write(`https://github.com/${state.repo}/pull/${number}\n`)
  } else if (['edit', 'merge', 'comment', 'review'].includes(args[1])) {
    const one = state.pulls.find(one => one.number === Number(args[2]))
    if (!one) { process.stderr.write('PR not found\n'); process.exitCode = 1 }
    else if (args[1] === 'merge' && one.head !== after('--match-head-commit')) {
      process.stderr.write('Head changed: --match-head-commit does not match\n'); process.exitCode = 1
    } else {
      if (args[1] === 'edit') {
        if (args.includes('--title')) one.title = after('--title')
        if (args.includes('--body')) one.body = after('--body')
      } else if (args[1] === 'merge') { one.merged = true; one.state = 'closed' }
      else if (args[1] === 'comment') (one.comments ??= []).push({ body: after('--body') })
      else (one.reviews ??= []).push({ body: after('--body'), event: args.find(arg => ['--approve', '--request-changes', '--comment'].includes(arg)) })
      one.updated = Date.now()
      writeFileSync(statePath, JSON.stringify(state, null, 2))
      process.stdout.write(`https://github.com/${state.repo}/pull/${one.number}\n`)
    }
  } else if (args[1] === 'view') {
    const selector = args[2], number = Number(selector.split('/').at(-1))
    const one = state.pulls.find(one => one.number === number || one.branch === selector)
    if (!one) { process.stderr.write('PR not found\n'); process.exitCode = 1 }
    else process.stdout.write(JSON.stringify(pullView(one)))
  } else { process.stderr.write('Unsupported PR command\n'); process.exitCode = 2 }
} else if (args[0] === 'issue' && (args[1] === 'view' || args[1] === 'comment')) {
  // The Git plugin's issue tools: read an issue, and post a comment to it as the signed-in account.
  const issue = state.issues.find((one) => one.number === Number(args[2]))
  if (!issue) {
    process.stderr.write(`GraphQL: Could not resolve to an issue with the number of ${args[2]}.\n`)
    process.exitCode = 1
  } else if (args[1] === 'view') {
    process.stdout.write(JSON.stringify({ number: issue.number, title: issue.title ?? `Issue ${issue.number}`, state: 'OPEN', url: `https://github.com/${state.repo}/issues/${issue.number}`, author: { login: state.user?.login ?? 'someone' }, body: issue.body ?? '', labels: [], comments: [] }))
    process.exitCode = 0
  } else {
    const at = args.indexOf('--body')
    const now = Date.now()
    const id = 8000 + state.issues.reduce((count, one) => count + one.comments.length, 0)
    issue.comments.push({ id, body: at === -1 ? '' : args[at + 1], created: now, updated: now })
    issue.updated = now
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    process.stdout.write(`https://github.com/${state.repo}/issues/${issue.number}#issuecomment-${id}\n`)
    process.exitCode = 0
  }
} else if (args[0] === 'api') {
  if (args[1] === 'graphql') {
    const numberArg = args.find(arg => arg.startsWith('number='))
    const one = state.pulls.find(pull => pull.number === Number(numberArg?.slice(7)))
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: one ? { state: one.merged ? 'MERGED' : one.state === 'closed' ? 'CLOSED' : 'OPEN', merged: !!one.merged, mergeQueueEntry: one.queued ? { id: 'fixture-queue' } : null, autoMergeRequest: null } : null } } }))
    process.exit(0)
  }
  const path = args.find(arg => arg === 'user' || arg.startsWith('repos/')) ?? args[args.length - 1]
  try {
    const body = answer(state, path)
    const jq = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : null
    if (jq === '.check_runs[]') process.stdout.write((body.check_runs ?? []).map(one => JSON.stringify(one)).join('\n'))
    else if (jq === '.login') process.stdout.write(body.login ?? '')
    else process.stdout.write(JSON.stringify(body))
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(`gh: ${error.message}\n`)
    process.exitCode = 1
  }
} else {
  process.stderr.write(`fake-gh: unsupported invocation: ${args.join(' ')}\n`)
  process.exitCode = 2
}
