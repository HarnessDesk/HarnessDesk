import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repositoryFiles } from './lib/repository-files.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Many of these run only when someone runs them — the screenshot rig, the
// probes — so one that no longer parses is found only then. Two branches that
// each declare a name in one scope merge without a conflict and fail that
// way: the rig's `press`, from #777 and #779.
//
// Syntax only. A script that parses can still fail on an import or at run
// time; this is the floor under all of them, not a check of what they do.

/** Every tracked script under `script/`, at any depth, as a path from `repo`. */
const scriptsIn = repo => repositoryFiles(repo).filter(file => file.startsWith('script/') && file.endsWith('.mjs'))

/** Each script under `script/` that does not parse, with what `node --check` said of it. */
const unparsed = repo => scriptsIn(repo).flatMap(file => {
  try {
    execFileSync(process.execPath, ['--check', join(repo, file)], { stdio: 'pipe' })
    return []
  } catch (error) {
    return [[file, String(error.stderr)]]
  }
})

test('every script parses', () => {
  assert.ok(scriptsIn(root).includes('script/shots/shoot.mjs'), 'the scripts are where this test looks')
  assert.deepEqual(unparsed(root), [])
})

test('a tracked script that does not parse is reported, however deep it sits', t => {
  const repo = mkdtempSync(join(tmpdir(), 'scripts-parse-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', repo])
  mkdirSync(join(repo, 'script/shots'), { recursive: true })
  writeFileSync(join(repo, 'script/fine.mjs'), 'export const fine = 1\n')
  writeFileSync(join(repo, 'script/shots/clash.mjs'), 'const press = 1\nconst press = 2\n')
  // Not the repository's until it is added, as every repository gate reads it.
  writeFileSync(join(repo, 'script/local.mjs'), 'const local =\n')
  execFileSync('git', ['add', 'script/fine.mjs', 'script/shots/clash.mjs'], { cwd: repo })
  const found = unparsed(repo)
  assert.deepEqual(found.map(([file]) => file), ['script/shots/clash.mjs'])
  assert.match(found[0][1], /Identifier 'press' has already been declared/)
})
