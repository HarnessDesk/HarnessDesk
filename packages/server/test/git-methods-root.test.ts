import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tempDir } from './scratch.js'
import { gitMethods } from '../src/methods/git.js'
import type { HostContext } from '../src/methods/context.js'

test('Git status carries the admitted directory mapping for aliases and subfolders', async () => {
  const scratch = tempDir('hd-git-mapping-'), repo = join(scratch, 'repo'), alias = join(scratch, 'alias')
  await mkdir(join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  await symlink(repo, alias)
  const canonical = await realpath(repo)
  const asked: string[] = []
  const ctx = { workspaces: { confineGitRoot: async (path: string) => {
    asked.push(path)
    if (!path.startsWith(`${alias}/`) && path !== alias) throw new Error('Outside the open folder')
    return realpath(path)
  } } } as unknown as HostContext
  for (const folder of ['', '/src']) {
    const status = await gitMethods['git/status'](ctx, { root: `${alias}${folder}` })
    assert.equal(status?.root, canonical)
    assert.equal((status as { resolvedRoot?: string } | null)?.resolvedRoot, `${canonical}${folder}`)
  }
  assert.deepEqual(asked, [alias, `${alias}/src`])
  await assert.rejects(gitMethods['git/status'](ctx, { root: `${alias}-sibling` }), /Outside/)
})
