import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { ExtensionKernel, type HarnessContext, type HarnessPlugin } from '../src/index.js'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

test('file reads and the workspace root follow each invocation checkout and stay confined to it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-fs-lanes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const one = join(root, 'one')
  const two = join(root, 'two')
  await Promise.all([mkdir(project), mkdir(one), mkdir(two)])
  // the same relative name in each folder, with different contents: a read from the wrong folder shows
  await Promise.all([
    writeFile(join(project, 'brief.md'), 'project brief'),
    writeFile(join(one, 'brief.md'), 'one brief'),
    writeFile(join(two, 'brief.md'), 'two brief'),
  ])
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: project, branch: 'main' })
  await kernel.load({
    manifest: { id: 'fs-lanes', name: 'File lanes', permissions: { workspace: { read: true } } },
    plugin: {
      name: 'fs-lanes', inject: ['tools', 'fs', 'workspace'],
      apply(ctx: HarnessContext) {
        ctx.tools.register({
          name: 'read', description: '', inputSchema: { type: 'object' },
          execute: async (args: { path: string; delay?: boolean }) => {
            if (args.delay) await new Promise((resolve) => setTimeout(resolve, 40))
            const content = await ctx.fs.read(args.path)
            const names = (await ctx.fs.list('.')).map((entry) => entry.name).join(',')
            return `${basename(ctx.workspace.root ?? '')}: ${content} [${names}] ${await ctx.fs.exists('brief.md')}`
          },
        })
      },
    },
  } as HarnessPlugin)
  await settle()
  const id = kernel.list('tool')[0]!.id
  const run = (workspaceRoot: string | undefined, args: { path: string; delay?: boolean }) =>
    kernel.invokeTool(id, args, workspaceRoot ? { workspaceRoot } : {})
  const output = (result: Awaited<ReturnType<typeof run>>) => result.ok ? result.content : result.error
  const text = (value: string) => [{ type: 'text', text: value }]

  // two seats at once, each in its own checkout, while the desk has a third folder open: the first is still
  // reading when the second starts, so a root shared between calls would hand the first the second's file
  const [first, second] = await Promise.all([run(one, { path: 'brief.md', delay: true }), run(two, { path: 'brief.md' })])
  assert.deepEqual(output(first), text('one: one brief [brief.md] true'))
  assert.deepEqual(output(second), text('two: two brief [brief.md] true'))

  // the caller's checkout is the boundary: the open workspace and a sibling checkout are outside it
  for (const path of [join(two, 'brief.md'), '../two/brief.md', join(project, 'brief.md')]) {
    const refused = await run(one, { path })
    assert.equal(refused.ok, false, path)
    assert.match(String(output(refused)), /outside the open workspace/)
  }

  // outside an invocation's checkout, the open workspace, as before
  assert.deepEqual(output(await run(undefined, { path: 'brief.md' })), text('project: project brief [brief.md] true'))
})
