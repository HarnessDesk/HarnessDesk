import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const planners = ['ci-changes', 'ci-unit-tests', 'ci-unit-shards', 'ui-impact', 'ci-browser-shards', 'ci-imports', 'node-tests']

// Planning runs before the install. Follow lazy literal imports too, since a
// load test alone cannot exercise imports inside every planning branch.
const specifiers = text => [...text.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\bfrom\s*)?(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"`])([^'"`\n$]+)\3/g)]
  .map(match => match[2] ?? match[4])
const bareImports = (directory, entries) => {
  const seen = new Set(), failures = []
  const visit = file => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue
      if (!/^\.{1,2}\//.test(specifier)) failures.push(`${relative(directory, file)}: ${specifier}`)
      else {
        assert.ok(specifier.endsWith('.mjs'), `${relative(directory, file)}: planner imports must name source .mjs files`)
        visit(resolve(dirname(file), specifier))
      }
    }
  }
  for (const entry of entries) visit(join(directory, entry))
  return failures
}

test('the dependency guard follows static imports, re-exports and lazy literal imports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-planners-'))
  try {
    mkdirSync(join(directory, 'script'))
    writeFileSync(join(directory, 'script/entry.mjs'), `import 'node:fs'
import {
  value,
} from './static.mjs'
export { value } from './exported.mjs'
const load = () => import('./lazy.mjs')
const template = () => import(\`./template.mjs\`)
`)
    for (const name of ['static', 'exported', 'lazy', 'template']) {
      writeFileSync(join(directory, `script/${name}.mjs`), `import value from 'fixture-${name}'\n`)
    }
    assert.deepEqual(bareImports(directory, ['script/entry.mjs']),
      ['static', 'exported', 'lazy', 'template'].map(name => `script/${name}.mjs: fixture-${name}`))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('every CI planner imports only builtins and dependency-free relative modules', () => {
  assert.deepEqual(bareImports(root, planners.map(name => `script/${name}.mjs`)), [])
})

test('the CI planners load from a script-only copy with no dependencies or build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-planners-'))
  try {
    cpSync(join(root, 'script'), join(directory, 'script'), { recursive: true })
    assert.equal(existsSync(join(directory, 'node_modules')), false)
    assert.equal(existsSync(join(directory, 'packages')), false)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `for (const name of ${JSON.stringify(planners)}) await import('./script/' + name + '.mjs')\nconsole.log('Planners loaded')`,
    ], { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'Planners loaded')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
