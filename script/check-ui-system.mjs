#!/usr/bin/env node

/** The stable local/CI entrypoint for the One UI System structural checks. */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const [script, ...args] of [
  ['script/ui-inventory.mjs', '--check'],
  ['script/ui-architecture.mjs'],
  ['script/ui-catalog.mjs'],
]) {
  execFileSync('node', [script, ...args], { cwd: root, stdio: 'inherit' })
}

process.stdout.write('One UI System inventory, architecture, and catalog coverage are current.\n')
