import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeId, type FileEntry, type RuntimeFiles, type HostParams } from '@harnessdesk/protocol'
import type { HostContext } from '../src/methods/context.js'
import { workspaceMethods } from '../src/methods/workspace.js'
const runtime = runtimeId('agent')
const rig = () => {
  const calls: string[] = []
  const entries: FileEntry[] = [
    { name: 'README.md', kind: 'file' }, { name: '.env.example', kind: 'file' },
    { name: 'src', kind: 'directory' }, { name: '.git', kind: 'directory' },
    { name: 'link', kind: 'other' }, { name: '../escape', kind: 'directory' },
  ]
  const files = { list: async (path: string) => { calls.push(path); return entries } } as unknown as RuntimeFiles
  const requested: unknown[] = []
  const ctx = { runtimes: { files: (id: unknown) => { requested.push(id); return files } },
    workspaces: { fileRoots: () => ['/project', '/other'] },
  } as unknown as HostContext
  return { ctx, calls, requested }
}
test('browse opt-in lists files and hidden project entries through the named runtime, bounded to its root', async () => {
  const { ctx, calls, requested } = rig()
  const result = await workspaceMethods['workspace/browse'](ctx, { mode: 'entries', root: '/project', runtime } as HostParams<'workspace/browse'>)
  assert.equal(result.path, '/project')
  assert.equal(result.parent, null)
  assert.deepEqual(result.entries, [
    { name: 'src', path: '/project/src', kind: 'directory' },
    { name: '.env.example', path: '/project/.env.example', kind: 'file' },
    { name: 'README.md', path: '/project/README.md', kind: 'file' },
  ])
  assert.deepEqual(calls, ['/project'])
  assert.deepEqual(requested, [runtime])
  const child = await workspaceMethods['workspace/browse'](ctx, { mode: 'entries', root: '/project', path: '/project/src', runtime } as HostParams<'workspace/browse'>)
  assert.equal(child.parent, '/project')
})
test('browse opt-in refuses relative roots and escape even into another opened root before listing', async () => {
  const { ctx, calls } = rig()
  for (const params of [
    { mode: 'entries', root: 'project' }, { mode: 'entries', root: '/closed' },
    { mode: 'entries', root: '/project', path: '/project/../other' },
    { mode: 'entries', root: '/project', path: '/project-sibling' },
  ] as const) await assert.rejects(async () => workspaceMethods['workspace/browse'](ctx, params as HostParams<'workspace/browse'>))
  assert.deepEqual(calls, [])
})
test('default browse retains the exact folder-picker shape and unconfined navigation', async () => {
  const { ctx } = rig()
  // Real runtime list entries have names, not paths; keep this fixture honest here.
  ctx.runtimes.files(runtime).list = async () => [
    { name: 'src', kind: 'directory' }, { name: '.hidden', kind: 'directory' }, { name: 'note', kind: 'file' },
  ]
  assert.deepEqual(await workspaceMethods['workspace/browse'](ctx, { path: '/unopened', runtime }), {
    path: '/unopened', parent: '/', entries: [{ name: 'src', path: '/unopened/src' }],
  })
})
