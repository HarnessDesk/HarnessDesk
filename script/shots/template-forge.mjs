#!/usr/bin/env node
/** A local, deterministic forge double. It never opens a network connection. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const statePath = process.env.HD_TEMPLATE_FORGE
if (!statePath) throw new Error('The template forge needs its disposable state file')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1] }
const branch = () => git('branch', '--show-current')
const write = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1) }
if (args[0] === 'api' && args[1] === 'user') write('demo-person')
else if (args[0] === 'api' && value('--method')) {
  const method = value('--method')
  const endpoint = args.find(one => one.startsWith('repos/'))
  const comments = 'repos/acme/storefront/issues/41/comments'
  if (!state.pr || !endpoint) fail('The template forge has no scripted answer for this API target')
  if (method === 'GET' && /^repos\/acme\/storefront\/issues\/41\/comments\?per_page=100&page=\d+$/.test(endpoint)) {
    write(endpoint.endsWith('page=1') ? state.comments ?? [] : [])
  } else if (method === 'POST' && endpoint === comments && value('--input') === '-') {
    const body = JSON.parse(readFileSync(0, 'utf8'))
    if (Object.keys(body).join(',') !== 'body' || !/^<!-- harnessdesk:finding-op pub-[0-9a-f]{48} -->\n/.test(body.body ?? '') ||
      !body.body.includes('**Review** · approve\n') || !body.body.includes(`reviewed ${state.pr.headRefOid.slice(0, 12)} in round 2 and raised no findings.`) || state.comments?.length) {
      fail('The template forge refuses this unscripted review comment')
    }
    const comment = { id: 72, body: body.body, user: { login: 'demo-person' },
      html_url: 'https://github.com/acme/storefront/pull/41#issuecomment-72' }
    state.comments = [comment]
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    write(comment)
  } else fail(`The template forge has no scripted answer for ${method} ${endpoint}`)
}
else if (args[0] === 'repo' && args[1] === 'view') write({ nameWithOwner: 'acme/storefront', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/storefront' })
else if (args[0] === 'pr' && args[1] === 'list') write(state.pr && state.pr.headRefName === value('--head') ? [state.pr] : [])
else if (args[0] === 'pr' && args[1] === 'create') {
  if (state.pr) fail('A scripted pull request is already open')
  state.pr = { number: 41, title: value('--title'), body: value('--body'), state: 'OPEN', isDraft: false,
    url: 'https://github.com/acme/storefront/pull/41', author: { login: 'demo-person' }, additions: 1, deletions: 0, changedFiles: 1,
    headRefName: value('--head') ?? branch(), baseRefName: 'main', headRefOid: git('rev-parse', 'HEAD'), statusCheckRollup: [] }
  writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  write(state.pr.url)
} else if (args[0] === 'pr' && args[1] === 'view') {
  const selector = args[2]?.startsWith('--') ? undefined : args[2]
  if (!state.pr || (!selector && branch() !== state.pr.headRefName)) fail('no pull requests found')
  write(state.pr)
} else if (args[0] === 'pr' && args[1] === 'checks') write([])
else fail(`The template forge has no scripted answer for ${args.slice(0, 2).join(' ')}`)
