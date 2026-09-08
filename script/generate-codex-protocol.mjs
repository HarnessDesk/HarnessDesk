#!/usr/bin/env node
/**
 * Regenerates the vendored Codex app-server protocol types.
 *
 * OpenAI ships the protocol as a generator rather than a published package, so
 * the honest way to track it is to run the generator against whatever Codex the
 * user has and vendor the output. Hand-transcribing 590+ types would guarantee
 * drift.
 *
 *   node script/generate-codex-protocol.mjs           # regenerate in place
 *   node script/generate-codex-protocol.mjs --check   # fail if vendored output is stale
 *
 * The one transformation applied to the generator's output is adding `.js`
 * extensions to relative imports, which NodeNext resolution requires and ts-rs
 * does not emit.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'packages/codex/src/generated')
const check = process.argv.includes('--check')

/**
 * The binary to generate from. `HARNESSDESK_CODEX_BINARY` is the same
 * override the app honours, so a drift check can be run against a version
 * that is not first on PATH — a fetched 0.153.0 beside an installed 0.149.0.
 */
const CODEX = process.env['HARNESSDESK_CODEX_BINARY'] || 'codex'

const codexVersion = () => {
  const raw = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()
  const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(raw)
  if (!match) throw new Error(`could not parse codex version from ${JSON.stringify(raw)}`)
  return match[1]
}

const walk = (dir, base = dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else if (entry.endsWith('.ts')) out.push(relative(base, full))
  }
  return out.sort()
}

/**
 * ts-rs emits extensionless relative imports; NodeNext needs `.js`, and a
 * directory specifier needs `/index.js`.
 */
const addExtensions = (source, file, dir) =>
  source.replace(/(from\s+")(\.\.?\/[^"]+)(")/g, (whole, head, spec, tail) => {
    if (spec.endsWith('.js')) return whole
    const target = resolve(dir, dirname(file), spec)
    const suffix = existsSync(target) && statSync(target).isDirectory() ? '/index.js' : '.js'
    return `${head}${spec}${suffix}${tail}`
  })

const generate = () => {
  const version = codexVersion()
  const tmp = mkdtempSync(join(tmpdir(), 'harnessdesk-codex-proto-'))
  try {
    execFileSync(CODEX, ['app-server', 'generate-ts', '--out', tmp, '--experimental'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const files = walk(tmp)
    if (files.length === 0) throw new Error('generator produced no files')
    const contents = new Map()
    for (const file of files) {
      contents.set(file, addExtensions(readFileSync(join(tmp, file), 'utf8'), file, tmp))
    }
    contents.set(
      'VERSION.json',
      `${JSON.stringify(
        {
          codexCliVersion: version,
          generatedFrom: 'codex app-server generate-ts --experimental',
          fileCount: files.length,
        },
        null,
        2,
      )}\n`,
    )
    return contents
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const readVendored = () => {
  if (!existsSync(outDir)) return new Map()
  const map = new Map()
  for (const file of walk(outDir)) map.set(file, readFileSync(join(outDir, file), 'utf8'))
  if (existsSync(join(outDir, 'VERSION.json'))) {
    map.set('VERSION.json', readFileSync(join(outDir, 'VERSION.json'), 'utf8'))
  }
  return map
}

/** `[major, minor, patch]` of a version string, prerelease tags ignored. */
const numeric = (version) => String(version).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
const olderThan = (a, b) => {
  const [x, y] = [numeric(a), numeric(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

if (check) {
  // The vendored set is generated from the newest Codex the app is built
  // against, which is allowed to be ahead of the binary a machine happens to
  // have on PATH — Codex ships several releases a day. An older binary can
  // only prove the vendored set is newer, not that it drifted, so the check
  // stands down with a note; `HARNESSDESK_CODEX_BINARY` names one to check
  // against instead.
  const vendoredVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(outDir, 'VERSION.json'), 'utf8')).codexCliVersion
    } catch {
      return null
    }
  })()
  const installed = codexVersion()
  if (vendoredVersion && olderThan(installed, vendoredVersion)) {
    console.log(
      `Vendored Codex protocol is from ${vendoredVersion}; the installed codex is ${installed}, which is older and cannot check it. ` +
        `Point HARNESSDESK_CODEX_BINARY at a ${vendoredVersion} binary to check drift.`,
    )
    process.exit(0)
  }
}

const generated = generate()

if (check) {
  const vendored = readVendored()
  const drift = []
  for (const [file, body] of generated) {
    if (!vendored.has(file)) drift.push(`missing: ${file}`)
    else if (vendored.get(file) !== body) drift.push(`changed: ${file}`)
  }
  for (const file of vendored.keys()) {
    if (!generated.has(file)) drift.push(`removed upstream: ${file}`)
  }
  if (drift.length > 0) {
    console.error(`Vendored Codex protocol is out of date (${drift.length} differences):`)
    for (const line of drift.slice(0, 25)) console.error(`  ${line}`)
    if (drift.length > 25) console.error(`  ... and ${drift.length - 25} more`)
    console.error('\nRun: pnpm run codex:protocol')
    process.exit(1)
  }
  console.log(`Vendored Codex protocol matches codex ${codexVersion()} (${generated.size} files).`)
  process.exit(0)
}

rmSync(outDir, { recursive: true, force: true })
for (const [file, body] of generated) {
  const target = join(outDir, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}
console.log(`Wrote ${generated.size} files to ${relative(root, outDir)} from codex ${codexVersion()}.`)
