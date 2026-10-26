import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A Node executable that could run the Lead's child. */
export interface LeadRuntime {
  readonly binary: string
  /** The Node version it claims; with `binary`, the key its probe result is cached under. */
  readonly version: string
  /** The host's own Electron binary, which runs as Node only with ELECTRON_RUN_AS_NODE. */
  readonly electron: boolean
  /** Names it in an unavailable reason: "this app's runtime", "bundled Node". */
  readonly label: string
}
export type LeadRuntimeProbe = { readonly supported: true } | { readonly supported: false; readonly reason: string }
export type LeadRuntimeChoice = { readonly runtime: LeadRuntime } | { readonly runtime: null; readonly reason: string }
export type LeadRuntimeProber = (runtime: LeadRuntime) => Promise<LeadRuntimeProbe>

/** The runtime this host process runs on: Node itself, or the desktop app's Electron. */
export const hostLeadRuntime = (): LeadRuntime => ({ binary: process.execPath, version: process.versions.node,
  electron: Boolean(process.versions['electron']), label: process.versions['electron'] ? "this app's runtime" : 'this Node' })

/** The child's whole environment. Locale and TLS trust use OS defaults. In particular NODE_OPTIONS, PATH,
 * vendor keys, home-directory markers and proxy variables never cross. Inside the desktop app the host is
 * Electron, so its binary is the Electron binary: without ELECTRON_RUN_AS_NODE it starts a second app
 * instead of running child.js, and the Lead's child exits before its first request. */
export const leadChildEnv = (source: NodeJS.ProcessEnv = process.env, electron = Boolean(process.versions['electron'])): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ['LANG', 'LC_ALL', 'TZ']) if (source[name]) env[name] = source[name]!
  if (electron) env['ELECTRON_RUN_AS_NODE'] = '1'
  return env
}

/** Read the exact package trees needed by the ESM/client loader. No repository,
 * home, journal, credential directory, generic node_modules or write grant. */
const readGrants = (): readonly string[] => {
  const leadDist = dirname(dirname(fileURLToPath(import.meta.url))), leadRoot = dirname(leadDist)
  // --preserve-symlinks keeps dependency reads at these exact package paths,
  // including pnpm's links, without needing a repository-wide node_modules grant.
  const client = join(leadRoot, 'node_modules/@harnessdesk/client')
  const protocol = join(leadRoot, 'node_modules/@harnessdesk/protocol')
  return [
    leadDist, join(leadRoot, 'package.json'), // This child's compiled implementation and package format.
    join(client, 'dist'), join(client, 'package.json'), // Public desk client implementation and package format.
    join(protocol, 'dist'), join(protocol, 'package.json'), // Portable vocabulary and wire validators.
    join(client, 'node_modules/@harnessdesk/protocol'), // The client's exact protocol dependency link.
    join(leadRoot, 'node_modules/ws'), // Only the WebSocket dependency and its own relative modules.
  ]
}
/** The Lead child's flags, then its entry. No network grant: only the connected socket the host hands over reaches the desk.
 * Residual: process.kill is outside Node's permission model; child code can still signal same-user processes. */
export const leadChildArgs = (entry = fileURLToPath(new URL('./child.js', import.meta.url))): readonly string[] =>
  ['--permission', '--no-allow-net', '--no-addons', '--preserve-symlinks', ...readGrants().map(path => `--allow-fs-read=${path}`), entry]

export const LEAD_PROBE_TIMEOUT_MS = 10_000
/** The probe child's one line: what `node:net` said to a loopback connect under the Lead's own flags. */
export const LEAD_PROBE_PREFIX = 'lead-probe '
const reasonText = (code: string) => code === 'connected' ? 'network not blocked by the permission model (loopback connect succeeded)'
  : `network not blocked by the permission model (loopback connect gave ${code})`

/** Spawns `runtime` with the Lead's exact flags and environment (leadChildEnv) and has it try a loopback TCP connect to a
 * listener this process owns. Supported means the permission model refused that connect (ERR_ACCESS_DENIED);
 * a connect that went through, a refused flag, a crash or no answer in time all mean unsupported. */
export const probeLeadRuntime = async (runtime: LeadRuntime, options: { timeoutMs?: number; entry?: string } = {}): Promise<LeadRuntimeProbe> => {
  let accepted = false
  const listener = createServer(socket => { accepted = true; socket.destroy() })
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => resolve()) })
  const port = (listener.address() as { port: number }).port
  try {
    return await new Promise<LeadRuntimeProbe>(resolve => {
      let stdout = '', settled = false
      const settle = (result: LeadRuntimeProbe) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); resolve(result) }
      const child = spawn(runtime.binary, [...leadChildArgs(options.entry ?? fileURLToPath(new URL('./probe-child.js', import.meta.url))), String(port)],
        { env: leadChildEnv(process.env, runtime.electron), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      const timeoutMs = options.timeoutMs ?? LEAD_PROBE_TIMEOUT_MS
      const timer = setTimeout(() => settle({ supported: false, reason: `the probe gave no answer within ${timeoutMs / 1000}s` }), timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { if (stdout.length < 4096) stdout += chunk })
      child.once('error', (error: NodeJS.ErrnoException) => settle({ supported: false, reason: `could not start (${error.code ?? 'spawn failed'})` }))
      child.once('close', (code, signal) => {
        const line = stdout.split('\n').find(line => line.startsWith(LEAD_PROBE_PREFIX))
        if (!line) return settle({ supported: false, reason: signal ? `exited on ${signal} before the probe ran`
          : code === 9 ? 'rejected the Lead flags (exit 9)' : `exited with code ${code} before the probe ran` })
        let report: { version?: unknown; outcome?: unknown }
        try { report = JSON.parse(line.slice(LEAD_PROBE_PREFIX.length)) } catch { return settle({ supported: false, reason: 'gave an unreadable probe answer' }) }
        if (report.version !== `v${runtime.version}`) return settle({ supported: false, reason: `reported ${String(report.version).slice(0, 32)}, expected v${runtime.version}` })
        if (accepted) return settle({ supported: false, reason: reasonText('connected') })
        settle(report.outcome === 'ERR_ACCESS_DENIED' ? { supported: true } : { supported: false, reason: reasonText(String(report.outcome).slice(0, 40)) })
      })
    })
  } finally { listener.close() }
}

const probes = new Map<string, Promise<LeadRuntimeProbe>>()
/** One probe per binary path and version for this process's lifetime, shared by concurrent callers. A timeout is
 * kept like any other answer: a runtime that cannot answer a loopback connect in time is not one to start a
 * Lead on, and the next launch of the app probes again. */
export const cachedLeadRuntimeProbe: LeadRuntimeProber = runtime => {
  const key = `${runtime.binary}\0${runtime.version}\0${runtime.electron}`
  let probe = probes.get(key)
  if (!probe) { probe = probeLeadRuntime(runtime).catch(() => ({ supported: false, reason: 'the probe could not run' }) as const); probes.set(key, probe) }
  return probe
}

/** The first candidate that passes the probe, or why none did, in candidate order. */
export const chooseLeadRuntime = async (candidates: readonly LeadRuntime[], probe: LeadRuntimeProber = cachedLeadRuntimeProbe): Promise<LeadRuntimeChoice> => {
  const reasons: string[] = []
  for (const runtime of candidates) {
    const result = await probe(runtime)
    if (result.supported) return { runtime }
    reasons.push(`${runtime.label} (Node ${runtime.version}) ${result.reason}`)
  }
  return { runtime: null, reason: reasons.length ? reasons.join('; ') : 'no runtime to run the Lead on' }
}
