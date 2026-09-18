import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repositoryFiles } from './lib/repository-files.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Many of these run only when someone runs them — the screenshot rig, the
// probes — so one that no longer parses is found only then. Two branches that
// each declare a name in one scope merge without a conflict and fail that
// way: the rig's `press`, from #777 and #779.
test('every script parses', () => {
  const scripts = repositoryFiles(root).filter(file => file.startsWith('script/') && file.endsWith('.mjs'))
  assert.ok(scripts.includes('script/shots/shoot.mjs'), 'the scripts are where this test looks')
  for (const file of scripts) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
  }
})
