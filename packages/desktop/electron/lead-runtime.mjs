import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The Node the app carries for the Lead's child, and nothing else.
 *
 * The child needs a permission model that blocks its network (`--no-allow-net`).
 * Electron 42's own Node 24 rejects that flag, so the packaged app bundles a
 * Node 26 LTS beside itself. `script/fetch-lead-node.mjs` downloads exactly this
 * version at pack time and source startup and refuses any archive whose SHA-256 differs from these.
 *
 * The bundled copy is only a fallback: when this app's own runtime passes the
 * Lead's capability probe it is used instead. Delete this file, the fetch hook
 * and the `lead-node` resource once the minimum supported Electron passes.
 */
export const LEAD_NODE = Object.freeze({
  version: '26.12.1',
  sha256: Object.freeze({
    arm64: '1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8',
    x64: 'b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff',
  }),
})

/** Where the bundled binary sits under the app's resources folder. */
export const LEAD_NODE_RESOURCE = 'lead-node/bin/node'

/** The app's runtime first; the packaged or fetched fallback still has to pass the host's probe. */
export const leadRuntimes = ({ execPath, versions, resourcesPath, packaged, arch = process.arch, desktopPath = fileURLToPath(new URL('../', import.meta.url)) }) => {
  const fetched = join(desktopPath, '.lead-node', arch, 'bin/node')
  return [
    { binary: execPath, version: versions.node, electron: Boolean(versions.electron), label: "this app's runtime" },
    ...(packaged
      ? [{ binary: join(resourcesPath, LEAD_NODE_RESOURCE), version: LEAD_NODE.version, electron: false, label: 'the bundled runtime' }]
      : existsSync(fetched) ? [{ binary: fetched, version: LEAD_NODE.version, electron: false, label: 'the fetched runtime' }] : []),
  ]
}
