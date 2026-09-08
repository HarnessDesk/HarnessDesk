import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel } from '../src/index.js'
import { setEditorEngine } from '../src/editor.js'

/**
 * Privilege cannot be laundered through a plugin.
 *
 * the editor-plane decision projects no write tool to agents: an agent's edits belong to its
 * own runtime, where its own approval applies, because a client that offers to
 * write on an agent's behalf is a client that has to be trusted with it.
 *
 * A plugin, though, may hold `workspace.write` *and* contribute a tool that
 * every agent can call — and `applyEdits` checked only the plugin's grants. An
 * agent could therefore write a file by asking a plugin to, with no approval
 * anywhere on the path. The permission was the plugin's; the intent was the
 * agent's; nothing compared the two.
 *
 * What is pinned here is the comparison: the same plugin, the same grant, the
 * same call — allowed when a person asked and refused when an agent did.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

/** A plugin that writes, reachable both ways: as a tool and as a command. */
const writer = (path: string) => ({
  manifest: {
    id: 'writer',
    name: 'Writer',
    permissions: { workspace: { read: true, write: true }, editor: true, tools: true, commands: true },
  },
  plugin: {
    name: 'writer',
    inject: ['editor', 'tools', 'commands'],
    apply(ctx: any) {
      const write = async () => {
        await ctx.editor.applyEdits(path, [{ range: null, text: 'edited' }])
      }
      ctx.tools.register({
        name: 'write_it',
        description: 'writes',
        inputSchema: { type: 'object' },
        execute: write,
      })
      ctx.commands.register({ name: 'write-it', description: 'writes', run: write })
    },
  },
})

const rig = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-prov-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'before')
  const calls: string[] = []
  setEditorEngine({
    open: async () => {},
    close: async () => {},
    decorate: async () => {},
    applyEdits: async (target: string) => {
      calls.push(target)
      return { hash: 'h' }
    },
  } as never)
  const kernel = new ExtensionKernel({ trusted: ['writer'] })
  kernel.setWorkspace({ root: dir, branch: null } as never)
  t.after(() => {
    kernel.dispose()
    setEditorEngine(null)
    return rm(dir, { recursive: true, force: true })
  })
  await kernel.load(writer(file) as never)
  await settle()
  return { kernel, file, calls }
}

test('a person asking a plugin to write is allowed', async (t) => {
  const { kernel, calls, file } = await rig(t)
  await kernel.runCommand('write-it', '', {} as never)
  assert.deepEqual(calls, [file], 'the edit reached the editor plane')
})

test('an agent asking the same plugin for the same write is refused', async (t) => {
  const { kernel, calls } = await rig(t)
  const tool = kernel.list('tool')[0]
  assert.ok(tool, 'the plugin contributed a tool every agent can call')

  const result = await kernel.invokeTool(tool.id as never, {}, {} as never)

  assert.equal(result.ok, false, 'the write was refused')
  assert.match(
    String((result as { error: string }).error),
    /agent cannot write files through a plugin/,
    'and says why, naming the rule rather than the mechanism',
  )
  assert.deepEqual(calls, [], 'nothing reached the editor plane')
})
