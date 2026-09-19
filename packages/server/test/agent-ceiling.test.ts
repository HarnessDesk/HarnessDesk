import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { digestOf } from '@harnessdesk/agent-inventory'
import { parseClientMessage, ValidationError, type AgentEntry, type CeilingUpdate } from '@harnessdesk/protocol'

import { ceilingEdit, parseAgentDefinition } from '../src/agent-def.js'
import { Host, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { shippedAgentsCopy, silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const OLD = '---\nname: Reviewer\ndescription: Reads a diff.\npermission: read\nprefer: [fake]\n---\nRead the diff.\n'

test('the permission: line is rewritten in place, and nothing else in the file moves', () => {
  const edit = ceilingEdit(OLD, 'edit')
  assert.ok(!('refused' in edit))
  assert.equal(edit.next, OLD.replace('permission: read', 'ceiling: edit'))
  assert.equal(edit.line, 4)
  assert.equal(edit.before, 'permission: read')
  assert.equal(edit.after, 'ceiling: edit')
  assert.equal(edit.diff, '@@ -3,3 +3,3 @@\n description: Reads a diff.\n-permission: read\n+ceiling: edit\n prefer: [fake]\n')
  const before = parseAgentDefinition(OLD, 'reviewer').agent
  const after = parseAgentDefinition(edit.next, 'reviewer').agent
  assert.equal(after?.ceiling, 'edit')
  assert.equal(after?.ceilingFrom, 'ceiling')
  assert.deepEqual({ ...after, ceilingFrom: 'permission' }, before)
  const narrowed = ceilingEdit(OLD, 'read')
  assert.ok(!('refused' in narrowed))
  assert.equal(parseAgentDefinition(narrowed.next, 'reviewer').agent?.ceiling, 'read')
})

test("the file's line endings, byte-order mark and an author's comment on the line survive the rewrite", () => {
  const crlf = '﻿---\r\nname: Win\r\npermission: publish  # only its own branch\r\n---\r\nBody.\r\n'
  const edit = ceilingEdit(crlf, 'publish')
  assert.ok(!('refused' in edit))
  assert.equal(edit.next, '﻿---\r\nname: Win\r\nceiling: publish  # only its own branch\r\n---\r\nBody.\r\n')
  assert.equal(edit.after, 'ceiling: publish  # only its own branch')
  assert.doesNotMatch(edit.diff, /\r/)
  assert.equal(parseAgentDefinition(edit.next, 'win').agent?.ceiling, 'publish')
})

test('an Agent that wrote neither key gets one line, at the foot of its front matter', () => {
  const none = '---\nname: Scout\n---\nLook around.\n'
  const edit = ceilingEdit(none, 'read')
  assert.ok(!('refused' in edit))
  assert.equal(edit.next, '---\nname: Scout\nceiling: read\n---\nLook around.\n')
  assert.equal(edit.line, 3)
  assert.equal(edit.before, null)
  assert.equal(edit.diff, '@@ -2,2 +2,3 @@\n name: Scout\n+ceiling: read\n ---\n')
})

test('a file with no front matter gets one holding only that line, and its brief is unchanged', () => {
  const bare = 'Look around.\n'
  const edit = ceilingEdit(bare, 'edit')
  assert.ok(!('refused' in edit))
  assert.equal(edit.next, '---\nceiling: edit\n---\nLook around.\n')
  assert.equal(edit.diff, '@@ -1,1 +1,4 @@\n+---\n+ceiling: edit\n+---\n Look around.\n')
  assert.equal(parseAgentDefinition(edit.next, 'scout').agent?.brief, parseAgentDefinition(bare, 'scout').agent?.brief)
})

test('it refuses, with why, wherever one line cannot be the whole change', () => {
  const refused = (source: string): string => {
    const edit = ceilingEdit(source, 'edit')
    assert.ok('refused' in edit, source)
    return edit.refused
  }
  assert.match(refused('---\nname: New\nceiling: read\n---\nx\n'), /already says ceiling:/)
  assert.match(refused('---\nname: Both\nceiling: read\npermission: read\n---\nx\n'), /both ceiling: and permission:/)
  assert.match(refused('---\nname: Open\npermission: read\nx\n'), /never closed/)
  assert.match(refused('---\nname: Long\npermission:\n  read\n---\nx\n'), /one plain word on one line/)
  assert.match(refused('---\nname: Quoted\npermission: "read"\n---\nx\n'), /one plain word on one line/)
})

const git = promisify(execFile)

const desk = async (t: TestContext) => {
  const stateDir = tempDir('hd-ceiling-state-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: await shippedAgentsCopy(),
    catalogRefreshMs: 0,
  })
  host.register(new FakeRuntime())
  await host.start()
  t.after(() => host.dispose())
  const project = tempDir('hd-ceiling-project-')
  await git('git', ['init', '-q', '-b', 'main'], { cwd: project })
  await mkdir(join(project, '.harnessdesk', 'agents', 'reviewer'), { recursive: true })
  const file = join(project, '.harnessdesk', 'agents', 'reviewer', 'AGENT.md')
  await writeFile(file, OLD, 'utf8')
  await git('git', ['add', '-A'], { cwd: project })
  await git('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', 'commit', '-qm', 'an Agent'], { cwd: project })
  await host.call('workspace/open', { path: project })
  return { host, stateDir, project, file }
}

test('through the host: Update… shows the one line, writes nothing, then writes exactly it — an ordinary change in the repository', async (t) => {
  const { host, project, file } = await desk(t)
  const shown = (await host.call('agent/ceiling/preview', { id: 'reviewer', origin: 'project', project, level: 'edit' })) as CeilingUpdate
  assert.equal(shown.before, 'permission: read')
  assert.equal(shown.after, 'ceiling: edit')
  assert.equal(shown.digest, digestOf(OLD))
  assert.equal(await readFile(file, 'utf8'), OLD)

  const entry = (await host.call('agent/ceiling/write', {
    id: 'reviewer', origin: 'project', project, level: 'edit', digest: shown.digest,
  })) as AgentEntry
  assert.equal(await readFile(file, 'utf8'), OLD.replace('permission: read', 'ceiling: edit'))
  assert.equal(entry.definition?.ceiling, 'edit')
  assert.equal(entry.definition?.ceilingFrom, 'ceiling')
  const { stdout } = await git('git', ['status', '--porcelain'], { cwd: project })
  assert.equal(stdout.trim(), 'M .harnessdesk/agents/reviewer/AGENT.md')
})

test('through the host: a file that moved on since it was shown is refused, and left as it is', async (t) => {
  const { host, project, file } = await desk(t)
  const shown = (await host.call('agent/ceiling/preview', { id: 'reviewer', origin: 'project', project, level: 'read' })) as CeilingUpdate
  const edited = OLD.replace('Reads a diff.', 'Reads a diff twice.')
  await writeFile(file, edited, 'utf8')
  await assert.rejects(
    host.call('agent/ceiling/write', { id: 'reviewer', origin: 'project', project, level: 'read', digest: shown.digest }),
    /has changed since the update was shown to you\. Open Update… again/,
  )
  assert.equal(await readFile(file, 'utf8'), edited)
})

test('through the host: an Agent folder that is a link is never written through', async (t) => {
  const { host, project } = await desk(t)
  const outside = tempDir('hd-ceiling-outside-')
  await writeFile(join(outside, 'AGENT.md'), OLD, 'utf8')
  const folder = join(project, '.harnessdesk', 'agents', 'reviewer')
  await rm(folder, { recursive: true })
  await symlink(outside, folder)
  await assert.rejects(
    host.call('agent/ceiling/write', { id: 'reviewer', origin: 'project', project, level: 'edit', digest: digestOf(OLD) }),
  )
  assert.equal(await readFile(join(outside, 'AGENT.md'), 'utf8'), OLD)
})

test('through the host: one of your Agents that wrote no ceiling gets the one line, and what ships cannot be updated', async (t) => {
  const { host, stateDir } = await desk(t)
  const folder = join(stateDir, 'agents', 'scout')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'AGENT.md'), '---\nname: Scout\n---\nLook around.\n', 'utf8')
  const shown = (await host.call('agent/ceiling/preview', { id: 'scout', origin: 'user', level: 'read' })) as CeilingUpdate
  assert.equal(shown.before, null)
  const entry = (await host.call('agent/ceiling/write', { id: 'scout', origin: 'user', level: 'read', digest: shown.digest })) as AgentEntry
  assert.equal(entry.definition?.ceiling, 'read')
  assert.equal(entry.definition?.ceilingFrom, 'ceiling')

  assert.throws(
    () => parseClientMessage({ id: 1, method: 'agent/ceiling/preview', params: { id: 'code-reviewer', origin: 'builtin', level: 'read' } }),
    ValidationError,
  )
  assert.throws(
    () => parseClientMessage({ id: 1, method: 'agent/ceiling/write', params: { id: 'scout', origin: 'user', level: 'owner', digest: 'd' } }),
    ValidationError,
  )
})
