import assert from 'node:assert/strict'
import test from 'node:test'
import { RULES } from './check-layering.mjs'

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
