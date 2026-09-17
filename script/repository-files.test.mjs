import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { repositoryFiles } from './lib/repository-files.mjs'

test('repository gates inspect existing tracked files, including staged additions, without local-only files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-files-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, 'tracked.tsx'), '<div />')
  fs.writeFileSync(path.join(root, 'deleted.svg'), '<svg />')
  execFileSync('git', ['add', 'tracked.tsx', 'deleted.svg'], { cwd: root })
  fs.unlinkSync(path.join(root, 'deleted.svg'))
  fs.writeFileSync(path.join(root, 'local-reference.svg'), '<svg />')
  assert.deepEqual(repositoryFiles(root), ['tracked.tsx'])
})
