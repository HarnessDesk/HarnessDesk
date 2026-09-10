import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, setForgeEngine, type ForgeEngine, type ForgeSeat } from '@harnessdesk/cordis-host'
import type { ContributionId, ForgeReference, ToolResult } from '@harnessdesk/protocol'

import { DEFAULT_REVIEW_SIGNATURE, DEFAULT_SIGNATURE, gitPlugin, renderSignature, signBody } from '../src/index.js'

/**
 * The Git plugin's forge tools, driven through the real kernel against a
 * `gh` that answers as GitHub would and writes down what it was asked. The
 * plugin reaches the forge with the person's own `gh` — so a fake one on
 * PATH is the whole of the forge here — and reaches the desk through
 * `ctx.forge`, which a stand-in engine answers.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const text = (result: ToolResult): string =>
  result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : `!${result.error}`

const SEAT: ForgeSeat = { agent: 'Codex', version: '0.153.0', model: 'GPT-5.4', effort: 'High', thinking: false, label: 'Codex GPT-5.4 · High' }

/** The `gh` GitHub would be, for one repository with one open pull request. */
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const home = process.env.GH_FAKE_HOME
fs.appendFileSync(path.join(home, 'calls.ndjson'), JSON.stringify(args) + '\n')
const after = (flag) => { const at = args.indexOf(flag); return at === -1 ? null : args[at + 1] }
const bodyFile = path.join(home, 'body.md')
const pr = () => ({
  number: 7, title: 'Add widgets', state: 'OPEN', isDraft: false,
  url: 'https://github.com/acme/widgets/pull/7', author: { login: 'octocat' },
  additions: 12, deletions: 3, changedFiles: 2,
  body: fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '',
  headRefName: 'feature', baseRefName: 'main',
})
const verb = args.slice(0, 2).join(' ')
if (verb === 'pr list') { process.stdout.write(fs.existsSync(bodyFile) ? JSON.stringify([{ number: 7, url: pr().url }]) : '[]'); process.exit(0) }
if (verb === 'pr create') { fs.writeFileSync(bodyFile, after('--body') ?? ''); process.stdout.write('https://github.com/acme/widgets/pull/7\n'); process.exit(0) }
if (verb === 'pr view') { process.stdout.write(JSON.stringify(pr())); process.exit(0) }
if (verb === 'pr edit') { const body = after('--body'); if (body !== null) fs.writeFileSync(bodyFile, body); process.exit(0) }
if (verb === 'pr review') { fs.writeFileSync(path.join(home, 'review.md'), after('--body') ?? ''); process.exit(0) }
if (verb === 'pr comment') { process.stdout.write('https://github.com/acme/widgets/pull/7#issuecomment-1\n'); process.exit(0) }
if (verb.startsWith('api')) { process.stdout.write('https://github.com/acme/widgets/pull/7#pullrequestreview-9\n'); process.exit(0) }
process.stderr.write('fake gh: unknown ' + verb + '\n'); process.exit(1)
`

interface Rig {
  readonly kernel: ExtensionKernel
  readonly repo: string
  readonly home: string
  readonly published: ForgeReference[]
  readonly seat: { current: ForgeSeat | null }
  tool(name: string): ContributionId
  calls(): string[][]
  run(name: string, args: unknown): Promise<string>
}

/**
 * A repository with a pushed branch, the fake `gh` first on PATH, a kernel
 * with the Git plugin loaded, and a forge engine that answers with one seat.
 */
const rig = async (t: { after(fn: () => void | Promise<void>): void }, config: Record<string, unknown> = {}): Promise<Rig> => {
  const root = mkdtempSync(join(tmpdir(), 'hd-forge-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'gh')
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  execFileSync('mkdir', ['-p', home, bin, repo])
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString()
  execFileSync('git', ['init', '-q', '--bare', remote])
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'main')

  const pathBefore = process.env['PATH']
  const homeBefore = process.env['GH_FAKE_HOME']
  process.env['PATH'] = `${bin}:${pathBefore ?? ''}`
  process.env['GH_FAKE_HOME'] = home
  t.after(() => {
    process.env['PATH'] = pathBefore
    if (homeBefore === undefined) delete process.env['GH_FAKE_HOME']
    else process.env['GH_FAKE_HOME'] = homeBefore
  })

  const published: ForgeReference[] = []
  const seat = { current: SEAT as ForgeSeat | null }
  const engine: ForgeEngine = {
    seat: async () => seat.current,
    identity: async () => ({ via: 'gh', login: 'octocat', available: true, reason: null }),
    publish: async (reference) => {
      published.push(reference)
    },
  }
  setForgeEngine(engine)
  t.after(() => setForgeEngine(null))

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(gitPlugin)
  if (Object.keys(config).length > 0) await kernel.reconfigure('git', config)
  await settle()
  kernel.setWorkspace({ root: repo, branch: 'main' })

  const tool = (name: string): ContributionId => {
    const found = kernel.list('tool').find((entry) => entry.name === name)
    assert.ok(found, `no tool named ${name}`)
    return found.id
  }
  return {
    kernel,
    repo,
    home,
    published,
    seat,
    tool,
    // No file is no calls: a refusal before the forge is reached is the point of some of these.
    calls: () =>
      existsSync(join(home, 'calls.ndjson'))
        ? readFileSync(join(home, 'calls.ndjson'), 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as string[])
        : [],
    run: async (name, args) => text(await kernel.invokeTool(tool(name), args, { runtime: 'codex', sessionId: 's1' } as never)),
  }
}

const bodySentTo = (calls: string[][], verb: string): string => {
  const call = calls.find((args) => args[0] === 'pr' && args[1] === verb)
  assert.ok(call, `gh pr ${verb} was called`)
  return call[call.indexOf('--body') + 1] ?? ''
}

test('pr_create signs the description for the seat and records the pull request in the conversation', async (t) => {
  const forge = await rig(t)
  const said = await forge.run('pr_create', { title: 'Add widgets', body: 'Widgets, as discussed.' })
  assert.match(said, /Opened pull request #7: Add widgets/)
  assert.match(said, /https:\/\/github\.com\/acme\/widgets\/pull\/7/)
  assert.match(said, /Signed for Codex GPT-5\.4 · High/)

  assert.equal(
    bodySentTo(forge.calls(), 'create'),
    'Widgets, as discussed.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)',
    'the signature is the last line, after a blank one, as GitHub renders it',
  )
  const create = forge.calls().find((args) => args[1] === 'create')!
  assert.ok(create.includes('--head') && create[create.indexOf('--head') + 1] === 'main', 'the head is the current branch')

  assert.equal(forge.published.length, 1)
  const reference = forge.published[0]!
  assert.equal(reference.kind, 'pullRequest')
  assert.equal(reference.action, 'opened')
  assert.equal(reference.repo, 'acme/widgets')
  assert.equal(reference.number, 7)
  assert.equal(reference.state, 'open')
  assert.equal(reference.author, 'octocat')
  assert.deepEqual([reference.additions, reference.deletions, reference.files], [12, 3, 2])
  assert.equal(reference.via, 'gh')
  assert.equal(reference.signature, '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)')
  assert.ok(reference.excerpt?.startsWith('Widgets, as discussed.'), 'the card gets the body as the forge holds it')
})

test('pr_create never pushes: an unpushed branch is refused with the command to run', async (t) => {
  const forge = await rig(t)
  execFileSync('git', ['checkout', '-q', '-b', 'feature/unpushed'], { cwd: forge.repo })
  const said = await forge.run('pr_create', { title: 'x', body: 'y' })
  assert.match(said, /has not been pushed/)
  assert.match(said, /git push -u origin feature\/unpushed/)
  assert.ok(!forge.calls().some((args) => args[1] === 'create'), 'gh was never asked to create anything')
  assert.equal(forge.published.length, 0)

  // Pushed once, then a commit on top: still refused, and the count is said.
  execFileSync('git', ['push', '-q', '-u', 'origin', 'feature/unpushed'], { cwd: forge.repo })
  writeFileSync(join(forge.repo, 'b.txt'), 'more\n')
  execFileSync('git', ['add', 'b.txt'], { cwd: forge.repo })
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'second'], { cwd: forge.repo })
  const again = await forge.run('pr_create', { title: 'x', body: 'y' })
  assert.match(again, /1 commit is not pushed yet/)
  assert.match(again, /git push/)
})

test('a pull request already open for the branch is named, not duplicated', async (t) => {
  const forge = await rig(t)
  await forge.run('pr_create', { title: 'Add widgets', body: 'first' })
  const said = await forge.run('pr_create', { title: 'Add widgets again', body: 'second' })
  assert.match(said, /Pull request #7 is already open for main/)
  assert.match(said, /pr_update/)
  assert.equal(forge.calls().filter((args) => args[1] === 'create').length, 1)
})

test('pr_update re-signs a new description, replacing the earlier line, and records the update', async (t) => {
  const forge = await rig(t)
  await forge.run('pr_create', { title: 'Add widgets', body: 'first' })
  forge.seat.current = { ...SEAT, model: 'GPT-5.4 Mini', label: 'Codex GPT-5.4 Mini · High' }
  const said = await forge.run('pr_update', { body: 'Rewritten.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)' })
  assert.match(said, /Updated pull request #7/)
  assert.equal(
    bodySentTo(forge.calls(), 'edit'),
    'Rewritten.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 Mini · High)',
    'one signature, the current seat’s',
  )
  assert.equal(forge.published.at(-1)?.action, 'updated')

  // A title alone changes no body and signs nothing.
  await forge.run('pr_update', { number: 7, title: 'Add the widgets' })
  const titleOnly = forge.calls().filter((args) => args[1] === 'edit').at(-1)!
  assert.ok(!titleOnly.includes('--body'))
  assert.equal(forge.published.at(-1)?.signature, null)
})

test('pr_review opens with the review line; pr_comment is unsigned', async (t) => {
  const forge = await rig(t)
  await forge.run('pr_create', { title: 'Add widgets', body: 'first' })
  const said = await forge.run('pr_review', { event: 'request_changes', body: 'The limiter leaks.' })
  assert.match(said, /Requested changes on pull request #7/)
  assert.equal(readFileSync(join(forge.home, 'review.md'), 'utf8'), '**Review by Codex GPT-5.4 · High · via HarnessDesk**\n\nThe limiter leaks.')
  const review = forge.calls().find((args) => args[1] === 'review')!
  assert.ok(review.includes('--request-changes'))
  const posted = forge.published.at(-1)!
  assert.equal(posted.kind, 'review')
  assert.equal(posted.url, 'https://github.com/acme/widgets/pull/7#pullrequestreview-9')

  await forge.run('pr_comment', { body: 'Also: the tests.' })
  const comment = forge.calls().find((args) => args[1] === 'comment')!
  assert.equal(comment[comment.indexOf('--body') + 1], 'Also: the tests.')
  assert.equal(forge.published.at(-1)?.kind, 'comment')
  assert.equal(forge.published.at(-1)?.signature, null)
  assert.equal(forge.published.at(-1)?.url, 'https://github.com/acme/widgets/pull/7#issuecomment-1')
})

test('a blank template signs nothing, and so does a seat the desk cannot name', async (t) => {
  const quiet = await rig(t, { signature: '' })
  const said = await quiet.run('pr_create', { title: 'Add widgets', body: 'plain' })
  assert.equal(bodySentTo(quiet.calls(), 'create'), 'plain')
  assert.match(said, /Unsigned: the signature is switched off/)
  assert.equal(quiet.published[0]?.signature, null)
})

test('a call the desk cannot place in a conversation is still made, and says it was unsigned', async (t) => {
  const forge = await rig(t)
  forge.seat.current = null
  const said = await forge.run('pr_create', { title: 'Add widgets', body: 'plain' })
  assert.equal(bodySentTo(forge.calls(), 'create'), 'plain')
  assert.match(said, /Unsigned: the desk could not tell which conversation/)
})

test('a person’s own template is rendered from the seat’s parts, and an empty part takes its separator with it', () => {
  assert.equal(renderSignature(DEFAULT_SIGNATURE, SEAT), '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)')
  assert.equal(renderSignature(DEFAULT_REVIEW_SIGNATURE, SEAT), '**Review by Codex GPT-5.4 · High · via HarnessDesk**')
  assert.equal(
    renderSignature('Written by {agent} {version} · {model} · {effort} effort', SEAT),
    'Written by Codex 0.153.0 · GPT-5.4 · High effort',
  )
  const bare: ForgeSeat = { agent: 'Gemini CLI', version: null, model: null, effort: null, thinking: false, label: 'Gemini CLI' }
  assert.equal(renderSignature('Written by {agent} {version} · {model} · via HarnessDesk', bare), 'Written by Gemini CLI · via HarnessDesk')
  assert.equal(renderSignature('   ', SEAT), '')
})

test('signing a body replaces an earlier HarnessDesk line and never doubles a blank', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  assert.equal(signBody('Body.\n\n', line), `Body.\n\n${line}`)
  assert.equal(signBody(`Body.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Old Seat)\n`, line), `Body.\n\n${line}`)
  assert.equal(signBody('', line), line)
  assert.equal(signBody(`Body.\n\n${line}`, null), 'Body.')
})
