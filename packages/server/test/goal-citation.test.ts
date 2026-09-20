import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { citationBlob } from '../src/goals/wrap.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd, env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com',
  } })).stdout.trim()

test('a citation stays at its exact committed regular file after HEAD moves', async () => {
  const root = tempDir('hd-goal-citation-')
  await git(root, 'init', '-q')
  await mkdir(`${root}/docs`)
  await writeFile(`${root}/docs/[receipt].md`, 'first\n')
  await writeFile(`${root}/target.txt`, 'target\n')
  await symlink('../target.txt', `${root}/docs/link.md`)
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', 'first')
  const first = await git(root, 'rev-parse', 'HEAD')
  await writeFile(`${root}/docs/[receipt].md`, 'second\n')
  await git(root, 'commit', '-qam', 'second')

  await citationBlob(root, 'docs/[receipt].md', first)
  await assert.rejects(citationBlob(root, 'docs/link.md', first), /not available at the recorded revision/)
  await assert.rejects(citationBlob(root, 'docs', first), /not available at the recorded revision/)
  await assert.rejects(citationBlob(root, '../target.txt', first), /relative document path/)
  await assert.rejects(citationBlob(root, 'docs/[receipt].md', first.slice(0, 12)), /full committed revision/)
  await assert.rejects(citationBlob(root, 'docs/missing.md', first), /not available at the recorded revision/)
})
