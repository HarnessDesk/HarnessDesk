import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { ExtensionKernel, type HarnessContext, type HarnessPlugin } from '../src/index.js'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))
const missing = async (path: string): Promise<boolean> => stat(path).then(() => false, () => true)

test('a tool call reads, lists, writes and names the root of its own checkout, and stays inside it', async (t) => {
  // The real path: the host compares a call's checkout with the open folder after resolving links (macOS's /var).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-fs-lanes-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const one = join(root, 'one')
  const two = join(root, 'two')
  await Promise.all([mkdir(project), mkdir(one), mkdir(two)])
  // The same relative name in every folder with different contents, and one file only that folder has: a read, a
  // listing or an existence check answered from the wrong folder shows in the answer.
  await Promise.all([project, one, two].flatMap((folder) => [
    writeFile(join(folder, 'brief.md'), `${basename(folder)} brief`),
    writeFile(join(folder, `only-${basename(folder)}.md`), ''),
  ]))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: project, branch: 'main' })
  await kernel.load({
    manifest: { id: 'fs-lanes', name: 'File lanes', permissions: { workspace: { read: true, write: true } } },
    plugin: {
      name: 'fs-lanes', inject: ['tools', 'fs', 'workspace', 'harness'],
      apply(ctx: HarnessContext) {
        ctx.tools.register({
          name: 'probe', description: '', inputSchema: { type: 'object' },
          execute: async (args: { delay?: boolean; read?: string; write?: string }) => {
            if (args.delay) await new Promise((resolve) => setTimeout(resolve, 40))
            if (args.read !== undefined) return await ctx.fs.read(args.read)
            if (args.write !== undefined) {
              await ctx.fs.write(args.write, basename(ctx.workspace.root ?? ''))
              return 'written'
            }
            return JSON.stringify({
              root: basename(ctx.workspace.root ?? ''),
              harness: basename(ctx.harness.workspaceRoot ?? ''),
              branch: ctx.workspace.branch,
              brief: await ctx.fs.read('brief.md'),
              names: (await ctx.fs.list('.')).map((entry) => entry.name).sort(),
              hasOne: await ctx.fs.exists('only-one.md'),
            })
          },
        })
      },
    },
  } as HarnessPlugin)
  await settle()
  const id = kernel.list('tool')[0]!.id
  type Probe = { delay?: boolean; read?: string; write?: string }
  const run = (workspaceRoot: string | undefined, args: Probe = {}) => kernel.invokeTool(id, args, workspaceRoot ? { workspaceRoot } : {})
  const answer = async (workspaceRoot: string | undefined, args: Probe = {}) => {
    const result = await run(workspaceRoot, args)
    if (!result.ok) assert.fail(result.error)
    const part = result.content[0]
    if (part?.type !== 'text') assert.fail('the probe answers in text')
    return JSON.parse(part.text)
  }

  // Two seats at once, each in its own checkout, while the desk has a third folder open. The first is still working
  // when the second starts, so a root shared between calls would hand the first the second's answers.
  const [first, second] = await Promise.all([answer(one, { delay: true }), answer(two)])
  // The branch is a fact about the open folder only: unknown in another checkout, as context resolution reports it.
  assert.deepEqual(first, { root: 'one', harness: 'one', branch: null, brief: 'one brief', names: ['brief.md', 'only-one.md'], hasOne: true })
  assert.deepEqual(second, { root: 'two', harness: 'two', branch: null, brief: 'two brief', names: ['brief.md', 'only-two.md'], hasOne: false })

  // A write lands in the caller's checkout, never in the open workspace.
  assert.deepEqual(await run(one, { write: 'note.md' }), { ok: true, content: [{ type: 'text', text: 'written' }] })
  assert.equal(await readFile(join(one, 'note.md'), 'utf8'), 'one')
  assert.equal(await missing(join(project, 'note.md')), true)

  // The caller's checkout is the boundary, for reading and for writing: the open workspace and a sibling are outside it.
  for (const path of [join(two, 'brief.md'), '../two/brief.md', join(project, 'brief.md')]) {
    for (const args of [{ read: path }, { write: path.replace('brief.md', 'escaped.md') }]) {
      const refused = await run(one, args)
      assert.equal(refused.ok, false, JSON.stringify(args))
      assert.match(refused.ok ? '' : refused.error, /outside the open workspace/)
    }
  }
  assert.equal(await missing(join(two, 'escaped.md')), true)
  assert.equal(await missing(join(project, 'escaped.md')), true)

  // A call whose checkout is the open folder knows its branch; a call with no checkout is the open workspace, as before.
  assert.equal((await answer(project)).branch, 'main')
  assert.deepEqual(await answer(undefined), { root: 'project', harness: 'project', branch: 'main', brief: 'project brief', names: ['brief.md', 'only-project.md'], hasOne: false })
})
