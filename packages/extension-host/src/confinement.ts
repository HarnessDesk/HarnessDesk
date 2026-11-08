import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * A plugin's process runs under the Node permission model.
 *
 * Isolation by process stops a plugin reaching into another's memory; it does
 * not stop one reading `~/.ssh` with `node:fs`, opening a socket with
 * `node:net` or starting a program with `node:child_process`. The permission
 * model does: the process is started with `--permission` and a read grant for
 * exactly the code it runs — this package's compiled child, the packages it
 * imports, and the plugin's own directory — with no write grant, no network,
 * no child processes, no workers and no native addons. What a plugin is
 * allowed to reach, it reaches through `ctx.fs`, `ctx.http`, `ctx.shell` and
 * `ctx.android`, which the parent serves against the grants the person agreed
 * to (see `PluginCapabilityHost`).
 *
 * Which runtime is used is decided by a probe, as it is for the Lead: the
 * candidate runs the child with these flags and tries a loopback connect, a
 * read of a file outside its grants and a spawn, and only a runtime that
 * refuses all three is used. With none, plugins run as before — isolated by
 * process, not confined — and the process's stats say why.
 *
 * Residual: `process.kill` is outside the permission model, so a plugin can
 * still signal processes of the same user.
 */

/** A Node executable that could run a plugin's process. The Lead's candidates have this shape. */
export interface PluginRuntime {
  readonly binary: string
  readonly version: string
  /** The host's own Electron binary, which runs as Node only with ELECTRON_RUN_AS_NODE. */
  readonly electron: boolean
  /** Names it in a reason: "this app's runtime", "the bundled runtime". */
  readonly label: string
}

export type PluginRuntimeChoice = { readonly runtime: PluginRuntime } | { readonly runtime: null; readonly reason: string }
export type PluginRuntimeProbe = { readonly supported: true } | { readonly supported: false; readonly reason: string }
export type PluginRuntimeProber = (runtime: PluginRuntime, entry: string) => Promise<PluginRuntimeProbe>

/** The runtime this host process runs on. */
export const hostPluginRuntime = (): PluginRuntime => ({
  binary: process.execPath,
  version: process.versions.node,
  electron: Boolean(process.versions['electron']),
  label: process.versions['electron'] ? "this app's runtime" : 'this Node',
})

/** The same path, as a process that is not Electron has to open it. */
const unpacked = (path: string): string => {
  const twin = path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  return twin !== path && existsSync(twin) ? twin : path
}

/**
 * A path as it resolves. A confined process is handed its plugin's directory
 * this way: the module loader resolves every symlink on the way to a file,
 * and each one it passes (`/var` on macOS) is a read the grants refuse.
 */
export const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The directory of a package named `name`, as Node finds it from `from`, and
 * every place Node looks on the way. The loader reads each candidate's
 * manifest at the path it looked under — a pnpm link, not its target — so
 * those paths are granted as well as the real one.
 */
const findPackage = (name: string, from: string): { readonly found: string; readonly looked: readonly string[] } | null => {
  const looked: string[] = []
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    looked.push(candidate)
    if (existsSync(join(candidate, 'package.json'))) return { found: real(candidate), looked }
    if (dirname(directory) === directory) return null
  }
}

const dependenciesOf = (directory: string): string[] => {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    return Object.keys(manifest.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * What the child's code is: this package's compiled output and every package
 * it imports, followed through their own dependencies. A workspace package is
 * granted its `dist` and manifest, never its source, tests or `node_modules`;
 * a published one is granted whole, since that is all it ships. Real paths,
 * because that is where the loader reads.
 */
export const childCodeGrants = (entry: string): readonly string[] => {
  const root = real(dirname(dirname(dirname(unpacked(entry)))))
  const grants = new Set<string>([join(root, 'dist'), join(root, 'package.json')])
  const seen = new Set<string>([root])
  const queue = [root]
  while (queue.length > 0) {
    const from = queue.shift()!
    for (const name of dependenciesOf(from)) {
      const located = findPackage(name, from)
      if (!located) continue
      for (const path of located.looked) grants.add(path)
      const { found } = located
      if (seen.has(found)) continue
      seen.add(found)
      queue.push(found)
      if (name.startsWith('@harnessdesk/') && existsSync(join(found, 'dist'))) {
        grants.add(join(found, 'dist'))
        grants.add(join(found, 'package.json'))
      } else {
        grants.add(found)
      }
    }
  }
  return [...grants]
}

let codeGrants: { readonly entry: string; readonly grants: readonly string[] } | null = null
const cachedCodeGrants = (entry: string): readonly string[] => {
  if (codeGrants?.entry !== entry) codeGrants = { entry, grants: childCodeGrants(entry) }
  return codeGrants.grants
}

/**
 * The flags, then the entry: read the child's code and the plugin's
 * directory, and nothing else. The directory is granted both as the host
 * names it and as it resolves, since the permission model checks the path a
 * call is given, and a home behind a symlink (`/var` on macOS) is two paths.
 */
export const confinedArgs = (entry: string, pluginDirectory: string): readonly string[] => [
  '--permission',
  '--no-allow-net',
  '--no-addons',
  ...[...new Set([...cachedCodeGrants(entry), resolve(pluginDirectory), real(pluginDirectory)])].map((path) => `--allow-fs-read=${path}`),
  unpacked(entry),
]

/** The process's environment marker for Electron; plain Node ignores it. */
export const runtimeEnvironment = (env: NodeJS.ProcessEnv, runtime: PluginRuntime): NodeJS.ProcessEnv => {
  const { ELECTRON_RUN_AS_NODE: _marker, ...rest } = env
  return runtime.electron ? { ...rest, ELECTRON_RUN_AS_NODE: '1' } : rest
}

/** The line a probing child answers with. */
export const PLUGIN_PROBE_PREFIX = 'HARNESSDESK_PLUGIN_PROBE '
export const PLUGIN_PROBE_TIMEOUT_MS = 10_000

/**
 * Runs `runtime` with the plugin flags in probe mode: the child loads its
 * whole module graph, then tries a loopback connect to a listener this
 * process owns, a read of a file this process wrote outside its grants, and a
 * spawn. Supported means the permission model refused all three.
 */
export const probePluginRuntime: PluginRuntimeProber = async (runtime, entry) => {
  const scratch = mkdtempSync(join(tmpdir(), 'hd-plugin-probe-'))
  const plugin = join(scratch, 'plugin')
  const secret = join(scratch, 'outside.txt')
  writeFileSync(secret, 'outside')
  let accepted = false
  const listener = createServer((socket) => {
    accepted = true
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (listener.address() as { port: number }).port
  try {
    // The plugin directory must exist for its grant to mean anything.
    mkdirSync(plugin)
    return await new Promise<PluginRuntimeProbe>((resolve) => {
      let stdout = ''
      let settled = false
      const settle = (result: PluginRuntimeProbe): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        resolve(result)
      }
      const child = spawn(runtime.binary, [...confinedArgs(entry, plugin), '--probe', String(port), secret], {
        env: runtimeEnvironment({ LANG: process.env['LANG'] ?? '' }, runtime),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const timer = setTimeout(() => settle({ supported: false, reason: `the probe gave no answer within ${PLUGIN_PROBE_TIMEOUT_MS / 1000}s` }), PLUGIN_PROBE_TIMEOUT_MS)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 4096) stdout += chunk
      })
      child.once('error', (error: NodeJS.ErrnoException) => settle({ supported: false, reason: `could not start (${error.code ?? 'spawn failed'})` }))
      child.once('close', (code, signal) => {
        const line = stdout.split('\n').find((one) => one.startsWith(PLUGIN_PROBE_PREFIX))
        if (!line) {
          return settle({
            supported: false,
            reason: signal ? `exited on ${signal} before the probe ran` : code === 9 ? 'rejected the permission flags (exit 9)' : `exited with code ${code} before the probe ran`,
          })
        }
        let report: Record<string, unknown>
        try {
          report = JSON.parse(line.slice(PLUGIN_PROBE_PREFIX.length)) as Record<string, unknown>
        } catch {
          return settle({ supported: false, reason: 'gave an unreadable probe answer' })
        }
        if (report['version'] !== `v${runtime.version}`) {
          return settle({ supported: false, reason: `reported ${String(report['version']).slice(0, 32)}, expected v${runtime.version}` })
        }
        const open = (['net', 'fs', 'spawn'] as const).filter((what) => report[what] !== 'ERR_ACCESS_DENIED')
        if (accepted && !open.includes('net')) open.unshift('net')
        if (open.length > 0) {
          const words = { net: 'the network', fs: 'files outside its grants', spawn: 'starting programs' }
          return settle({ supported: false, reason: `does not refuse ${open.map((what) => words[what]).join(', ')}` })
        }
        settle({ supported: true })
      })
    })
  } finally {
    listener.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

const probes = new Map<string, Promise<PluginRuntimeProbe>>()

/** One probe per runtime and entry for this process's lifetime, shared by concurrent callers. */
export const cachedPluginRuntimeProbe: PluginRuntimeProber = (runtime, entry) => {
  const key = `${runtime.binary}\0${runtime.version}\0${runtime.electron}\0${entry}`
  let probe = probes.get(key)
  if (!probe) {
    probe = probePluginRuntime(runtime, entry).catch(() => ({ supported: false, reason: 'the probe could not run' }) as const)
    probes.set(key, probe)
  }
  return probe
}

/** The first candidate that confines a plugin, or why none does, in candidate order. */
export const choosePluginRuntime = async (
  candidates: readonly PluginRuntime[],
  entry: string,
  probe: PluginRuntimeProber = cachedPluginRuntimeProbe,
): Promise<PluginRuntimeChoice> => {
  const reasons: string[] = []
  for (const runtime of candidates) {
    const result = await probe(runtime, entry)
    if (result.supported) return { runtime }
    reasons.push(`${runtime.label} (Node ${runtime.version}) ${result.reason}`)
  }
  return { runtime: null, reason: reasons.length > 0 ? reasons.join('; ') : 'no runtime to confine plugins on' }
}
