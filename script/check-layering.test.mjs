import assert from 'node:assert/strict'
import test from 'node:test'
import { RULES } from './check-layering.mjs'

const boundaryRule = (pkg) => {
  const rule = RULES.find((r) => r.label === `${pkg} import boundary`)
  assert.ok(rule, `${pkg} import boundary exists`)
  return rule
}

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
