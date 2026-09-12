import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, setForgeEngine, type ForgeEngine, type ForgeSeat } from '@harnessdesk/cordis-host'
import type { ContributionId, ForgeReference, ToolResult } from '@harnessdesk/protocol'

import { DEFAULT_REVIEW_SIGNATURE, DEFAULT_SIGNATURE, SIGNATURE_MARK, gitPlugin, previousSignature, renderSignature, signBody, unmarked } from '../src/index.js'

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
if (verb === 'pr edit') { const body = after('--body'); if (body !== null) fs.writeFileSync(bodyFile, body); process.exit(0) }
if (verb === 'pr review') { fs.writeFileSync(path.join(home, 'review.md'), after('--body') ?? ''); process.exit(0) }
if (verb === 'pr comment') { process.stdout.write('https://github.com/acme/widgets/pull/7#issuecomment-1\n'); process.exit(0) }
if (verb === 'pr view' || verb === 'pr checks') {
  // Nothing by that number — said the way gh says it, behind the notice it prints about itself first.
  if (args[2] === '999') { process.stderr.write('A new release of gh is available: 2.60.0 → 2.61.0\nTo upgrade, run: brew upgrade gh\nhttps://github.com/cli/cli/releases/tag/v2.61.0\nGraphQL: Could not resolve to a PullRequest with the number of 999.\n'); process.exit(1) }
}
if (verb === 'pr view') { process.stdout.write(JSON.stringify(pr())); process.exit(0) }
if (verb === 'pr checks') { process.stdout.write(JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1', workflow: 'CI' }, { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://ci/2' }, { name: 'deploy', state: 'PENDING', bucket: 'pending' }])); process.exit(8) }
if (verb === 'issue view') { process.stdout.write(JSON.stringify({ number: 42, title: 'Widgets wobble', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/42', author: { login: 'octocat' }, body: 'They wobble.', labels: [{ name: 'bug' }], comments: [{ author: { login: 'hubot' }, body: 'Confirmed.', createdAt: '2026-09-10T00:00:00Z' }] })); process.exit(0) }
if (verb === 'issue comment') { process.stdout.write('https://github.com/acme/widgets/issues/42#issuecomment-2\n'); process.exit(0) }
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
    `Widgets, as discussed.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High) ${SIGNATURE_MARK}`,
    'the signature is the last line, after a blank one, marked as the desk’s own; GitHub renders the mark as nothing',
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
  assert.ok(!reference.excerpt?.includes('<!--'), 'without the mark, which is the desk’s and not text')
  assert.ok(!(await forge.run('pr_view', {})).includes('<!--'), 'nor does a read show it')
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
    `Rewritten.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 Mini · High) ${SIGNATURE_MARK}`,
    'one signature, the current seat’s — the unmarked default-shaped line from before the mark existed is gone',
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

test('signing a body marks the desk’s line, replaces a marked or a legacy one, and never doubles a blank', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  const marked = `${line} ${SIGNATURE_MARK}`
  assert.equal(signBody('Body.\n\n', line), `Body.\n\n${marked}`)
  // The desk's own earlier line, wherever the agent left it in the body it passes back.
  assert.equal(signBody(`Body.\n\nOld seat's line ${SIGNATURE_MARK}\n`, line), `Body.\n\n${marked}`)
  assert.equal(signBody(`Body.\n\nWhatever ${SIGNATURE_MARK}\n\nA line the agent added after it.`, line), `Body.\n\nA line the agent added after it.\n\n${marked}`)
  // A description signed before the mark existed: the default's shape, as the last line only.
  assert.equal(signBody(`Body.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Old Seat)\n`, line), `Body.\n\n${marked}`)
  assert.equal(signBody('', line), marked)
  assert.equal(signBody(`Body.\n\n${marked}`, null), 'Body.')
  assert.equal(signBody(`Body.\n\n${line}`, null), 'Body.')
  // A line the author quoted stays; only the desk's own trailing line is replaced.
  const quoted = `The default is:\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) ({seat})\n\nMore.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Old Seat)`
  assert.equal(signBody(quoted, line), `The default is:\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) ({seat})\n\nMore.\n\n${marked}`)
  assert.equal(unmarked(`Text ${SIGNATURE_MARK}\nmore`), 'Text\nmore')
})

test('a person’s own template is replaced on update, whatever it says, because the desk marked its own line', async (t) => {
  const own = await rig(t, { signature: 'Written by {agent} · {model}' })
  await own.run('pr_create', { title: 'Add widgets', body: 'first' })
  assert.equal(bodySentTo(own.calls(), 'create'), `first\n\nWritten by Codex · GPT-5.4 ${SIGNATURE_MARK}`)
  own.seat.current = { ...SEAT, model: 'GPT-5.4 Mini', label: 'Codex GPT-5.4 Mini · High' }
  // The agent passes the description back as GitHub holds it, mark and all.
  await own.run('pr_update', { body: `Rewritten.\n\nWritten by Codex · GPT-5.4 ${SIGNATURE_MARK}` })
  assert.equal(bodySentTo(own.calls(), 'edit'), `Rewritten.\n\nWritten by Codex · GPT-5.4 Mini ${SIGNATURE_MARK}`, 'one line, the current seat’s, whatever the template says')
  // A description signed before the mark existed still loses its default-shaped line.
  await own.run('pr_update', { body: 'Older.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)' })
  assert.equal(own.calls().filter((args) => args[1] === 'edit').at(-1)!.at(-1), `Older.\n\nWritten by Codex · GPT-5.4 Mini ${SIGNATURE_MARK}`)
  own.seat.current = { agent: 'Gemini CLI', version: null, model: null, effort: null, thinking: false, label: 'Gemini CLI' }
  await own.run('pr_update', { body: `Bare.\n\nWritten by Codex · GPT-5.4 Mini ${SIGNATURE_MARK}` })
  assert.equal(own.calls().filter((args) => args[1] === 'edit').at(-1)!.at(-1), `Bare.\n\nWritten by Gemini CLI ${SIGNATURE_MARK}`)
})

test('an author’s last line that resembles a signature is the author’s, and stays', async (t) => {
  // Every shape the round-2 reviewers named: a template's skeleton, a bullet, brackets.
  const skeleton = await rig(t, { signature: 'Written by {agent} · {model}' })
  await skeleton.run('pr_create', { title: 'Add widgets', body: 'first' })
  await skeleton.run('pr_update', { body: 'Prose.\n\nWritten by humans · mostly' })
  assert.equal(
    bodySentTo(skeleton.calls(), 'edit'),
    `Prose.\n\nWritten by humans · mostly\n\nWritten by Codex · GPT-5.4 ${SIGNATURE_MARK}`,
    'a line that fits the template’s shape is not the desk’s: it stays, and the signature follows it',
  )
  const bullet = await rig(t, { signature: '- {seat}' })
  await bullet.run('pr_create', { title: 'Add widgets', body: 'first' })
  await bullet.run('pr_update', { body: 'Changes:\n- Fixed race condition in worker' })
  assert.equal(bodySentTo(bullet.calls(), 'edit'), `Changes:\n- Fixed race condition in worker\n\n- Codex GPT-5.4 · High ${SIGNATURE_MARK}`)
  const brackets = await rig(t, { signature: '({seat})' })
  await brackets.run('pr_create', { title: 'Add widgets', body: 'first' })
  await brackets.run('pr_update', { body: 'Done.\n\n(closes #456)' })
  assert.equal(bodySentTo(brackets.calls(), 'edit'), `Done.\n\n(closes #456)\n\n(Codex GPT-5.4 · High) ${SIGNATURE_MARK}`)
  // A bare placeholder, the same seat: the exact rendering, unmarked, is still the desk's and is replaced once.
  const bare = await rig(t, { signature: '{seat}' })
  await bare.run('pr_create', { title: 'Add widgets', body: 'first' })
  await bare.run('pr_update', { body: 'Prose ends here.\n\nCodex GPT-5.4 · High' })
  assert.equal(bodySentTo(bare.calls(), 'edit'), `Prose ends here.\n\nCodex GPT-5.4 · High ${SIGNATURE_MARK}`)
})

test('checks, issues and their comments are read and posted, and the record says the subject', async (t) => {
  const forge = await rig(t)
  await forge.run('pr_create', { title: 'Add widgets', body: 'first' })
  const checks = await forge.run('pr_checks', {})
  assert.match(checks, /Checks on pull request #7/)
  assert.match(checks, /✓ build \(CI\) https:\/\/ci\/1/)
  assert.match(checks, /✗ lint https:\/\/ci\/2/)
  assert.match(checks, /… deploy/)

  const issue = await forge.run('issue_view', { number: 42 })
  assert.match(issue, /#42 Widgets wobble/)
  assert.match(issue, /open · acme\/widgets · opened by octocat · bug/)
  assert.match(issue, /They wobble\./)
  assert.match(issue, /Discussion:\nhubot \(2026-09-10T00:00:00Z\):\nConfirmed\./)

  const said = await forge.run('issue_comment', { number: 42, body: 'On it.' })
  assert.match(said, /Commented on issue #42: Widgets wobble/)
  const posted = forge.published.at(-1)!
  assert.equal(posted.kind, 'comment')
  assert.equal(posted.subject, 'issue')
  assert.equal(posted.number, 42)
  assert.equal(posted.url, 'https://github.com/acme/widgets/issues/42#issuecomment-2')
  assert.equal(posted.state, 'open')
  const comment = forge.calls().find((args) => args[0] === 'issue' && args[1] === 'comment')!
  assert.equal(comment[comment.indexOf('--body') + 1], 'On it.')

  // A comment on a pull request says so too — said, not guessed from the size.
  await forge.run('pr_comment', { body: 'And here.' })
  assert.equal(forge.published.at(-1)?.subject, 'pullRequest')
})

test('gh’s own upgrade notice is not the error', async (t) => {
  const forge = await rig(t)
  const said = await forge.run('pr_view', { number: 999 })
  assert.match(said, /GraphQL: Could not resolve to a PullRequest with the number of 999/)
  assert.doesNotMatch(said, /new release|upgrade/)
})

test('a thinking seat can say so in a template, and a seat that is not says nothing', () => {
  assert.equal(renderSignature('{agent} {thinking}', { ...SEAT, thinking: true }), 'Codex Thinking')
  assert.equal(renderSignature('{agent} {thinking}', SEAT), 'Codex')
  assert.equal(renderSignature('{agent} · {thinking} · via HarnessDesk', { ...SEAT, thinking: true }), 'Codex · Thinking · via HarnessDesk')
})

test('a mark quoted in a code fence or a code span is the author’s, and only the desk’s own line goes', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  const body = [
    'The desk marks its line like this:',
    '```',
    `Signature ${SIGNATURE_MARK}`,
    '```',
    `and in prose as \`${SIGNATURE_MARK}\` too.`,
    '',
    `Old seat's line ${SIGNATURE_MARK}`,
  ].join('\n')
  assert.equal(
    signBody(body, line),
    [
      'The desk marks its line like this:',
      '```',
      `Signature ${SIGNATURE_MARK}`,
      '```',
      `and in prose as \`${SIGNATURE_MARK}\` too.`,
      '',
      `${line} ${SIGNATURE_MARK}`,
    ].join('\n'),
  )
  // The last marked line outside a fence is the desk's, wherever it stands.
  assert.equal(
    signBody(`First ${SIGNATURE_MARK}\n\n\`\`\`\nsample ${SIGNATURE_MARK}\n\`\`\``, line),
    `\`\`\`\nsample ${SIGNATURE_MARK}\n\`\`\`\n\n${line} ${SIGNATURE_MARK}`,
  )
  assert.equal(previousSignature(body), "Old seat's line")
  assert.equal(previousSignature('```\nsample <!-- harnessdesk:signature -->\n```'), null)
})

test('a body copied out of a read and passed back without the mark still loses exactly the earlier line', async (t) => {
  const forge = await rig(t, { signature: 'Written by {agent} · {model}' })
  await forge.run('pr_create', { title: 'Add widgets', body: 'first' })
  // The agent reads the description — the mark is not text and is not shown — edits it, and passes it back.
  const read = await forge.run('pr_view', {})
  assert.ok(read.endsWith('first\n\nWritten by Codex · GPT-5.4'), read)
  forge.seat.current = { ...SEAT, model: 'GPT-5.4 Mini', label: 'Codex GPT-5.4 Mini · High' }
  await forge.run('pr_update', { body: 'first, edited.\n\nWritten by Codex · GPT-5.4' })
  assert.equal(
    bodySentTo(forge.calls(), 'edit'),
    `first, edited.\n\nWritten by Codex · GPT-5.4 Mini ${SIGNATURE_MARK}`,
    'the line the desk signed with last time, read off GitHub’s copy, is the one replaced',
  )
})

test('a fence is closed by its own character, at its own length, with nothing after it (#157)', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  const sample = `sample ${SIGNATURE_MARK}`
  /* GitHub does not treat the two fence characters as interchangeable, and one
     toggled flag cannot say which opened the block. Each body below ends
     *inside* a fence, so every mark in it is the author's and the desk has
     none of its own: a body that reads one of them as the desk's line deletes
     a line of somebody's code block on the next pr_update. */
  const inside = [
    // A tilde fence inside a backtick fence, and the reverse.
    ['```', '~~~', sample, '~~~', '```'],
    ['~~~', '```', sample, '```', '~~~'],
    // Four backticks quoting a three-backtick sample: how a description shows
    // a fenced block at all, and the commonest of these shapes by far.
    ['````', '```', sample, '```', '````'],
    // A closing fence carries no info string, so the ```js is content.
    ['```', '```js', sample, '```'],
    // Unclosed, which CommonMark runs to the end of the document.
    ['```', sample],
  ]
  for (const lines of inside) {
    const body = lines.join('\n')
    assert.equal(previousSignature(body), null, body)
    assert.equal(signBody(body, line), `${body}\n\n${line} ${SIGNATURE_MARK}`, body)
  }
  // A body GitHub hands back with CRLF endings closes its fences the same way.
  assert.equal(previousSignature(`\`\`\`\r\n${sample}\r\n\`\`\`\r\nOld line ${SIGNATURE_MARK}`), 'Old line')
  // Controls, true before this rule and after it: a plain fence hides its
  // mark, and a mark outside every fence is the desk's own line.
  assert.equal(previousSignature(['```', sample, '```'].join('\n')), null)
  assert.equal(previousSignature(`Old line ${SIGNATURE_MARK}`), 'Old line')
})

test('a fence indented under a list or a quote is still a fence, and the mark in it is the author’s (#275 r1)', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  const sample = `sample ${SIGNATURE_MARK}`
  /* CommonMark puts a fenced block inside a list item at its container's
     indent plus up to three, so four spaces under `- item` is an ordinary
     fence rather than an indented code block. Reading only `^ {0,3}` put the
     reader *outside* these fences, and that is the direction that deletes:
     the mark in the sample reads as the desk's own line, and the next
     pr_update splices out that line of somebody's code. Every body here ends
     inside a fence, so the desk has no line of its own in any of them. */
  const inside = [
    // A fenced sample under a list item, at the container's indent plus two.
    ['- item', '', '    ```', `    ${sample}`, '    ```'],
    // A nested list indents its container further still.
    ['- outer', '  - inner', '', '      ```', `      ${sample}`, '      ```'],
    // A blockquote's marker is depth of another kind, and was never read as
    // depth at all — this shape mis-read before the fence rules as well.
    ['> ```', `> ${sample}`, '> ```'],
    ['- item', '', '  > ```', `  > ${sample}`, '  > ```'],
    // Deep enough that CommonMark calls it an indented code block rather than
    // a fence. The mark inside one is still not the desk's line, so reading
    // it as fenced is the harmless way to be wrong.
    ['Prose:', '', '        ```', `        ${sample}`, '        ```'],
  ]
  for (const lines of inside) {
    const body = lines.join('\n')
    assert.equal(previousSignature(body), null, body)
    assert.equal(signBody(body, line), `${body}\n\n${line} ${SIGNATURE_MARK}`, body)
  }
  // A fence left open inside a quote is not closed by the bare fence below
  // the quote: CommonMark opens a new block there, so the line under it is
  // the author's on either reading, and counting `>` as depth is what sees
  // it. Reading `>` as nothing at all made this line the desk's.
  assert.equal(previousSignature(['> ```', '> a', '```', `Old line ${SIGNATURE_MARK}`].join('\n')), null)
  // A top-level block whose *content* is an indented fence line. Closing on
  // depth it never opened at would end the block there and expose the sample
  // under it — which is exactly how the rule before #157 read this shape, and
  // what reading any indent as an opener would bring back without this.
  assert.equal(previousSignature(['```', '    ```', sample, '```'].join('\n')), null)
  // Controls, true before this rule and after it. An indented fence still
  // *closes*, which is what keeps the looseness from reading a whole body as
  // one unterminated block: the desk's own line below the sample is found and
  // replaced, not appended to.
  const closed = ['- item', '', '    ```', `    ${sample}`, '    ```', '', `Old line ${SIGNATURE_MARK}`]
  assert.equal(previousSignature(closed.join('\n')), 'Old line')
  assert.equal(signBody(closed.join('\n'), line), [...closed.slice(0, -1), `${line} ${SIGNATURE_MARK}`].join('\n'))
  // And the three rules #157 fixed hold at depth too: the longer fence a
  // description quotes a sample with is not closed by the shorter one inside
  // it, so the line below the real close is the desk's.
  const quoted = ['- item', '', '    ````', '    ```', `    ${sample}`, '    ```', '    ````', '', `Old line ${SIGNATURE_MARK}`]
  assert.equal(previousSignature(quoted.join('\n')), 'Old line')
  // An indent of three or less was always read as a fence.
  assert.equal(previousSignature(['1. item', '', '   ```', `   ${sample}`, '   ```'].join('\n')), null)
  assert.equal(previousSignature(`Old line ${SIGNATURE_MARK}`), 'Old line')
})

test('a quoted fence does not close an indented one, and a body that ends inside a fence has no line to replace (#275 r2)', () => {
  const line = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)'
  const sample = `sample ${SIGNATURE_MARK}`
  /* Whitespace and `>` are different kinds of depth, and one bought its way
     past the other while both were measured as the length of one prefix:
     `> ` is shorter than four spaces and deeper in quotes at the same time,
     so a quoted fence under an opener indented four satisfied `indent <=
     openIndent` *and* `quotes >= openQuotes` at once and closed a block
     CommonMark still reads as open. Every body here ends inside a fence, so
     every mark in it is the author's; reading one as the desk's own line
     splices a line of somebody's code block out on the next pr_update. */
  const inside = [
    ['- item', '', '    ```', '    code before', '> ```', `    ${sample}`],
    ['    ```', '    code', '> ```', sample],
    ['    ```', `    ${sample}`, '> ```', `below the false close ${SIGNATURE_MARK}`],
    ['    ~~~', '    code', '> ~~~', sample],
  ]
  for (const lines of inside) {
    const body = lines.join('\n')
    assert.equal(previousSignature(body), null, body)
    assert.equal(signBody(body, line), `${body}\n\n${line} ${SIGNATURE_MARK}`, body)
  }
  // A run-on costs only a duplicated line while there is no earlier mark to
  // fall back on. Here the quote's fence is never closed and swallows the
  // desk's own line, and the marked line above it is the author's — pasted
  // out of another description — so handing that back is a deletion rather
  // than a duplicate. A body ending inside a fence yields no line at all.
  const swallowed = [`Pasted from another description ${SIGNATURE_MARK}`, '> ```', '> code', `Old line ${SIGNATURE_MARK}`]
  assert.equal(previousSignature(swallowed.join('\n')), null)
  assert.equal(signBody(swallowed.join('\n'), line), `${swallowed.join('\n')}\n\n${line} ${SIGNATURE_MARK}`)
  // Controls, true before this rule and after it. A fence opened inside a
  // quote still closes inside the same quote, at that depth or a shallower
  // indent, and the desk's line below it is replaced rather than appended to.
  const quoted = ['> ```', `> ${sample}`, '> ```', '', `Old line ${SIGNATURE_MARK}`]
  assert.equal(previousSignature(quoted.join('\n')), 'Old line')
  assert.equal(signBody(quoted.join('\n'), line), [...quoted.slice(0, -1), `${line} ${SIGNATURE_MARK}`].join('\n'))
  assert.equal(previousSignature(['  > ```', '  > code', '> ```', '', `Old line ${SIGNATURE_MARK}`].join('\n')), 'Old line')
  // A fence opened deeper in `>` is not closed by a shallower one, nor by a
  // wider indent inside the same quote.
  assert.equal(previousSignature(['> > ```', `> > ${sample}`, '> ```', `Old line ${SIGNATURE_MARK}`].join('\n')), null)
  assert.equal(previousSignature(['> ```', '> code', '>     ```', sample].join('\n')), null)
  // And round 1's list-indented close still fires.
  assert.equal(previousSignature(['- item', '', '    ```', `    ${sample}`, '    ```', '', `Old line ${SIGNATURE_MARK}`].join('\n')), 'Old line')
})
