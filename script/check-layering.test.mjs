import assert from 'node:assert/strict'
import test from 'node:test'
import { RULES } from './check-layering.mjs'
import { projectsOf, globToRegExp, TEST_GLOB } from './prune-dist.mjs'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as layering from './check-layering.mjs'

const boundaryRule = (pkg) => {
  const rule = RULES.find((r) => r.label === `${pkg} import boundary`)
  assert.ok(rule, `${pkg} import boundary exists`)
  return rule
}

test('Lead core refuses ambient machine, loader, evaluator and network authority', () => {
  const rule = boundaryRule('lead')
  for (const source of [
    "process.getBuiltinModule('node:fs')", "process.getBuiltinModule('node:child_process')",
    'const p = process', 'globalThis.process', "globalThis['fetch']('https://example.com')",
    'global.process', "const r = require; r('node:fs')", "module.require('node:fs')",
    "eval('process')", "(0, eval)('process')", "new Function('return process')()",
    "Function('return process')()", 'const F = Function', 'import.meta.resolve',
    "import.meta['resolve']", "fetch('https://example.com')", 'const send = fetch',
    "new WebSocket('wss://example.com')", 'new XMLHttpRequest()', "Buffer.from('x')",
  ]) {
    for (const file of ['loop.ts', 'nested/helper.ts', 'nested/child.ts', 'nested/supervisor.ts'])
      assert.ok(rule.offenders(source, `packages/lead/src/${file}`).length > 0, `${file}: ${source}`)
    for (const file of ['child.ts', 'supervisor.ts'])
      assert.deepEqual(rule.offenders(source, `packages/lead/src/${file}`), [], `${file}: ${source}`)
  }
  assert.deepEqual(rule.offenders("// process.getBuiltinModule('node:fs')\nconst explanation = 'fetch eval Function globalThis'", 'packages/lead/src/loop.ts'), [])
})

test('Lead loop refuses machine, host, adapter, computed and escaping dependencies', () => {
  const rule = boundaryRule('lead')
  for (const source of [
    "import 'node:fs'", "import 'fs'", "import 'electron'",
    "import '@harnessdesk/server'", "export * from '@harnessdesk/adapter-codex'",
    "export { Host } from '../../server/src/index.js'",
    "type Host = import('@harnessdesk/server').Host", "import '@deepseek-ai/cordis'",
    "require('@harnessdesk/adapter-acp')", "import host = require('@harnessdesk/server')",
    "await import(dependency)", "await import('@harnessdesk/' + name)",
    "require(dependency)", "import './child.js'", "export * from './supervisor.js'",
    "import '@harnessdesk/client/node'", "import '@harnessdesk/client/views'",
    "import './helper.js?fresh'", "import './%63hild.js'", "import '../test/helper.js'",
    "import './child/index.js'", "import './supervisor/index.js'",
  ]) assert.equal(rule.offenders(source, 'packages/lead/src/loop.ts').length, 1, source)
  for (const source of [
    "import '@harnessdesk/protocol'", "import type { ClientEvent } from '@harnessdesk/client'",
    "export * from './ports.js'", "await import('./permissions.js')",
    "// import 'node:fs'\nconst example = 'electron'",
  ]) assert.deepEqual(rule.offenders(source, 'packages/lead/src/loop.ts'), [], source)
  assert.equal(rule.offenders("import '../child.js'", 'packages/lead/src/nested/helper.ts').length, 1)
})

test('only exact Lead child and supervisor entries may import Node and client transport', () => {
  const rule = boundaryRule('lead')
  for (const source of ["import 'node:process'", "import 'node:https'", "import '@harnessdesk/client/node'"]) {
    for (const entry of ['child', 'supervisor']) {
      assert.deepEqual(rule.offenders(source, `packages/lead/src/${entry}.ts`), [], source)
      assert.equal(rule.offenders(source, `packages/lead/src/nested/${entry}.ts`).length, 1, source)
    }
  }
  assert.deepEqual(rule.offenders("import './child.js'", 'packages/lead/src/supervisor.ts'), [])
  for (const source of ["import 'electron'", "import '@harnessdesk/server'", "await import(dependency)", "import 'keytar'"])
    assert.equal(rule.offenders(source, 'packages/lead/src/child.ts').length, 1, source)
})

test('Lead entries have explicit Node module allowlists', () => {
  const rule = boundaryRule('lead')
  for (const module of ['https', 'process', 'readline', 'stream', 'events', 'timers/promises', 'crypto', 'url'])
    for (const entry of ['child', 'supervisor'])
      assert.deepEqual(rule.offenders(`import 'node:${module}'`, `packages/lead/src/${entry}.ts`), [])
  for (const module of ['child_process', 'path']) {
    assert.deepEqual(rule.offenders(`import 'node:${module}'`, 'packages/lead/src/supervisor.ts'), [])
    assert.equal(rule.offenders(`import 'node:${module}'`, 'packages/lead/src/child.ts').length, 1)
  }
  for (const module of ['fs', 'fs/promises', 'vm', 'module', 'worker_threads'])
    for (const entry of ['child', 'supervisor'])
      for (const source of [`import 'node:${module}'`, `export * from 'node:${module}'`, `await import('node:${module}')`])
        assert.equal(rule.offenders(source, `packages/lead/src/${entry}.ts`).length, 1, source)
})

test('Lead generated sources remain in the layering scan', t => {
  const root = mkdtempSync(join(tmpdir(), 'hd-lead-layering-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const pkg of ['lead', 'client'])
    for (const name of ['generated', 'dist', 'node_modules']) {
      const directory = join(root, 'packages', pkg, 'src', name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'helper.ts'), "export const fs = process.getBuiltinModule('node:fs')")
    }
  assert.equal(typeof layering.sourceFilesOf, 'function')
  const files = layering.sourceFilesOf('lead', root)
  assert.deepEqual(files.sort(), ['dist', 'generated', 'node_modules'].map(name => join(root, 'packages/lead/src', name, 'helper.ts')).sort())
  for (const file of files)
    assert.ok(boundaryRule('lead').offenders("export const fs = process.getBuiltinModule('node:fs')", file).length > 0)
  assert.deepEqual(layering.sourceFilesOf('client', root), [])
})

test('renderer cannot import or re-export Lead by package or relative path', () => {
  const rule = boundaryRule('ui lead')
  for (const source of ["import '@harnessdesk/lead'", "export * from '@harnessdesk/lead/supervisor'", "await import('../../../lead/src/index.js')", "type Lead = import('../../../lead/src/ports.js').LeadPorts", "require('../../../lead/dist/src/index.js')"])
    assert.equal(rule.offenders(source, 'packages/ui/src/lib/lead.ts').length, 1, source)
  assert.deepEqual(rule.offenders("import type { LeadThread } from '@harnessdesk/protocol'", 'packages/ui/src/state/lead.ts'), [])
})

test('renderer refuses absolute filesystem and computed specifiers with an explicit remedy', () => {
  const rule = boundaryRule('ui lead')
  const absolute = fileURLToPath(new URL('../packages/lead/src/index.ts', import.meta.url))
  for (const source of [`import ${JSON.stringify(absolute)}`, `export * from ${JSON.stringify(absolute)}`,
    "import 'C:/workspace/demo/packages/lead/src/index.js'", "import 'file:///workspace/demo/packages/lead/src/index.js'", 'await import(dependency)'])
    assert.ok(rule.offenders(source, 'packages/ui/src/state/lead.ts').length > 0, source)
  assert.match(rule.remedy, /computed/i)
  assert.match(rule.remedy, /absolute/i)
})

test('Lead also belongs to the Codex, Cordis and keystore prohibitions', () => {
  for (const label of ['Codex above adapter-codex', 'Cordis above cordis-host', 'keystore access outside the broker'])
    assert.ok(RULES.find(rule => rule.label === label)?.packages.includes('lead'), label)
})

test('Lead joins the root build and prune graph and normal Node test glob', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const projects = projectsOf(root)
  assert.ok(projects.some(project => project.options.configFilePath.endsWith('/packages/lead/tsconfig.json')))
  assert.ok(globToRegExp(TEST_GLOB).test('packages/lead/dist/test/ports.test.js'))
})

test('client import boundary checks real static, dynamic, export and require specifiers', () => {
  const rule = boundaryRule('client')
  for (const source of [
    "import { Host } from '@harnessdesk/server'",
    "export * from '@harnessdesk/ui'",
    "export { open } from '@harnessdesk/desktop'",
    "await import('@harnessdesk/adapter-acp')",
    "require('@harnessdesk/codex')",
    "import cordis = require('@deepseek-ai/cordis')",
    "type Host = import('@harnessdesk/server').Host",
    "import 'some-other-library'",
    "import { x } from '../../server/src/index.js'",
    "export * from '../../protocol/src/index.js'",
    "await import(dependency)",
    "await import('@harnessdesk/' + name)",
    "require(dependency)",
  ]) assert.equal(rule.offenders(source, 'packages/client/src/index.ts').length, 1, source)
  for (const source of [
    "import type { HostToClient } from '@harnessdesk/protocol'",
    "export { WireCallError } from './core.js'",
    "await import('./projection.js')",
    "require('./queue.js')",
    "// import '@harnessdesk/server'\nconst explanation = '@harnessdesk/server'",
    'const example = "import(\'node:fs\')"',
  ]) assert.deepEqual(rule.offenders(source, 'packages/client/src/index.ts'), [], source)
})

test('only exact client Node entry imports ws and node builtins, and core cannot import that entry', () => {
  const rule = boundaryRule('client')
  for (const source of ["import 'ws'", "import 'node:fs'", "export * from 'node:path'", "await import('node:net')", "require('node:crypto')"]) {
    assert.equal(rule.offenders(source, 'packages/client/src/index.ts').length, 1, source)
    assert.equal(rule.offenders(source, 'packages/client/src/nested/node.ts').length, 1, source)
    assert.deepEqual(rule.offenders(source, 'packages/client/src/node.ts'), [], source)
  }
  for (const source of ["import './node.js'", "export * from './nested/../node.ts'", "await import('@harnessdesk/client/node')", "require('../dist/node.js')"]) {
    assert.equal(rule.offenders(source, 'packages/client/src/index.ts').length, 1, source)
  }
  assert.equal(rule.offenders("import '../node.js'", 'packages/client/src/nested/core.ts').length, 1)
  assert.deepEqual(rule.offenders("import './index.js'", 'packages/client/src/node.ts'), [])
  assert.equal(rule.offenders("import 'other-library'", 'packages/client/src/node.ts').length, 1)
  assert.equal(rule.offenders("import '../../server/src/index.js'", 'packages/client/src/node.ts').length, 1)
})

test('cli import boundary permits client entries and protocol while refusing backend and external imports', () => {
  const rule = boundaryRule('cli')
  for (const source of [
    "import '@harnessdesk/client'", "import '@harnessdesk/client/node'",
    "import type { ClientTopic } from '@harnessdesk/protocol'", "import './cli.js'",
  ]) assert.deepEqual(rule.offenders(source, 'packages/cli/src/bin.ts'), [], source)
  for (const source of [
    "import '@harnessdesk/server'", "export * from '@harnessdesk/ui'",
    "await import('@harnessdesk/desktop')", "require('@harnessdesk/adapter-codex')",
    "import '@harnessdesk/codex'", "import '@deepseek-ai/cordis'", "import 'ws'",
    "import 'node:fs'", "import 'other-library'", "import '@harnessdesk/client-internal'",
    "import '../../server/src/index.js'", "import '../../client/src/node.js'",
    "await import(dependency)", "require(dependency)",
  ]) assert.equal(rule.offenders(source, 'packages/cli/src/bin.ts').length, 1, source)
  assert.deepEqual(rule.offenders("const description = '@harnessdesk/server'; // require('ws')", 'packages/cli/src/bin.ts'), [])
})

test('relative import boundaries refuse URL suffixes and encoded paths', () => {
  for (const pkg of ['client', 'cli']) {
    const rule = boundaryRule(pkg)
    for (const source of [
      "import './node.js?fresh'", "export * from './node.js#entry'",
      "await import('./%6eode.js')", "require('./%2e%2e/%2e%2e/server/src/index.js')",
    ]) assert.equal(rule.offenders(source, `packages/${pkg}/src/index.ts`).length, 1, source)
    assert.deepEqual(rule.offenders("import './helper.js'", `packages/${pkg}/src/index.ts`), [])
  }
})

test('layering check catches node builtins in renderer with single quotes, double quotes, dynamic imports, and side-effect imports (#488)', () => {
  const rule = RULES.find((r) => r.label === 'node builtins in the renderer')
  assert.ok(rule, 'rule for node builtins in the renderer exists')

  const forbiddenSamples = [
    "import fs from 'node:fs'",
    'import fs from "node:fs"',
    'import { readFile } from "node:fs/promises"',
    'import type { Buffer } from "node:buffer"',
    'import "node:path"',
    "import 'node:buffer'",
    'const fs = await import("node:fs")',
    "const fs = await import('node:fs')",
    'require("node:fs")',
    "require('node:fs')",
    'export * from "node:fs"',
    "export { join } from 'node:path'",
  ]

  for (const sample of forbiddenSamples) {
    assert.ok(
      rule.forbidden.test(sample),
      `expected sample to be caught by forbidden pattern: ${sample}`,
    )
  }

  const allowedSamples = [
    'const node: DockNode = parent',
    'export const walk = (node: Element) => {}',
    'const description = "node: not an import"',
    "import { Button } from './Button.js'",
  ]

  for (const sample of allowedSamples) {
    assert.equal(
      rule.forbidden.test(sample),
      false,
      `expected allowed sample not to be caught: ${sample}`,
    )
  }
})

test('the renderer imports only the public client views entry', () => {
  const rule = boundaryRule('ui client')
  for (const source of ["import '@harnessdesk/client/views'", "export * from '@harnessdesk/client/views'", "type Row = import('@harnessdesk/client/views').SeatRow", "import './helper'"])
    assert.deepEqual(rule.offenders(source, 'packages/ui/src/lib/team-overview.ts'), [], source)
  for (const source of ["import '@harnessdesk/client'", "export * from '@harnessdesk/client/node'", "await import('@harnessdesk/client/views/private')", "require('@harnessdesk/client/core')", "import '../../../client/src/index.js'", "export * from '../../../client/src/views/index.js'"])
    assert.equal(rule.offenders(source, 'packages/ui/src/lib/team-overview.ts').length, 1, source)
})

test('client views import only protocol and their own files', () => {
  const rule = boundaryRule('client')
  for (const source of ["import '@harnessdesk/protocol'", "export * from './team-overview.js'", "import '../snapshot.js'"])
    assert.deepEqual(rule.offenders(source, 'packages/client/src/views/nested/index.ts'), [], source)
  for (const source of ["import '@harnessdesk/client'", "export * from '@harnessdesk/client/node'", "import '../index.js'", "export * from '../node.js'", "await import('ws')", "type Stats = import('node:fs').Stats", "import '@harnessdesk/server'", "require('../../test/fixture.js')", "import './helper.js?fresh'", "await import(dependency)"])
    assert.equal(rule.offenders(source, 'packages/client/src/views/index.ts').length, 1, source)
})
