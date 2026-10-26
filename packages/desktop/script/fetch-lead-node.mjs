#!/usr/bin/env node
/**
 * Pack-time fetch of the Node the app bundles for the Lead's child.
 *
 * electron-builder calls `beforePack` once per architecture, before it copies
 * `extraResources`; this downloads the pinned darwin build from nodejs.org,
 * checks its SHA-256 against `electron/lead-runtime.mjs`, and fails the build on
 * any mismatch. Only the `node` binary and its LICENSE are kept, under
 * `.lead-node/<arch>/`, which `build.extraResources` copies to
 * `Contents/Resources/lead-node` and `build.mac.binaries` signs with the app.
 *
 *   node script/fetch-lead-node.mjs arm64|x64
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LEAD_NODE } from '../electron/lead-runtime.mjs'

export const LEAD_NODE_DIR = fileURLToPath(new URL('../.lead-node/', import.meta.url))
/** electron-builder's `Arch` enum, for the two architectures the app ships. */
const ARCH = { 1: 'x64', 3: 'arm64' }

export const leadNodeUrl = (version, arch) => `https://nodejs.org/dist/v${version}/node-v${version}-darwin-${arch}.tar.gz`

/** Downloads, verifies and unpacks the pinned binary into `<into>/<arch>`; a verified copy already there is kept. */
export const fetchLeadNode = async ({ arch, into = LEAD_NODE_DIR, pin = LEAD_NODE, fetch = globalThis.fetch, log = console.log }) => {
  const expected = pin.sha256[arch]
  if (!expected) throw new Error(`fetch-lead-node: no pinned SHA-256 for darwin-${arch}`)
  const dest = join(into, arch), stamp = join(dest, '.verified'), binary = join(dest, 'bin/node')
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8') === `${pin.version} ${expected}\n`) return binary
  const url = leadNodeUrl(pin.version, arch)
  log(`fetch-lead-node: downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch-lead-node: ${url} answered ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) throw new Error(`fetch-lead-node: SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}`)
  const work = mkdtempSync(join(tmpdir(), 'hd-lead-node-'))
  try {
    const tarball = join(work, 'node.tar.gz'), top = `node-v${pin.version}-darwin-${arch}`
    writeFileSync(tarball, archive)
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', work, `${top}/bin/node`, `${top}/LICENSE`], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`fetch-lead-node: could not unpack ${url}: ${tar.stderr}`)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(join(dest, 'bin'), { recursive: true })
    copyFileSync(join(work, top, 'bin/node'), binary)
    chmodSync(binary, 0o755)
    copyFileSync(join(work, top, 'LICENSE'), join(dest, 'LICENSE'))
    writeFileSync(stamp, `${pin.version} ${expected}\n`)
  } finally { rmSync(work, { recursive: true, force: true }) }
  log(`fetch-lead-node: verified Node ${pin.version} for darwin-${arch}`)
  return binary
}

/** electron-builder hook (`build.beforePack`). */
export const beforePack = async (context) => {
  if (context.electronPlatformName !== 'darwin') throw new Error(`fetch-lead-node: the app bundles Node for macOS only, not ${context.electronPlatformName}`)
  const arch = ARCH[context.arch]
  if (!arch) throw new Error(`fetch-lead-node: no pinned Node for electron-builder arch ${context.arch}`)
  await fetchLeadNode({ arch })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arch = process.argv[2]
  if (!['arm64', 'x64'].includes(arch)) {
    console.error('usage: node script/fetch-lead-node.mjs arm64|x64')
    process.exit(2)
  }
  await fetchLeadNode({ arch })
}
