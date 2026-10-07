/** No prompts: count only this probe's process tree in an isolated home. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const module = process.argv[3]
  ? pathToFileURL(process.argv[3]).href
  : new URL('../../packages/adapter-acp/dist/src/index.js', import.meta.url).href
const { AcpRuntime } = await import(module)
const home = await mkdtemp(join(tmpdir(), 'hd-acp-process-probe-'))
await mkdir(join(home, 'work'))
const runtime = new AcpRuntime({ ...config, env: { ...config.env,
  HOME: home, HARNESSDESK_HOME: join(home, 'desk'), XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
  CLAUDE_CONFIG_DIR: join(home, 'claude'), CLAUDE_ACP_STATE_DIR: join(home, 'claude-bridge'), CLAUDECODE: '',
  CURSOR_CONFIG_DIR: join(home, 'cursor'), CURSOR_ACP_STATE_DIR: join(home, 'cursor-bridge'),
  DSH_HOME: join(home, 'dsh'),
} })
const deadline = async (operation) => {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), 30_000)
  })]) } finally { clearTimeout(timer) }
}
const snapshot = () => {
  // comm, unlike args, contains no account, folder or prompt. Nothing from ps is printed.
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,stat=,comm='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => { const [pid, parent, rss, state, ...comm] = line.trim().split(/\s+/); return { pid: +pid, parent: +parent, rss: +rss, state, comm: comm.join(' ') } })
  const descendants = new Set([process.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true }
  }
  const kept = rows.filter(row => row.pid !== process.pid && !/[ZE]/.test(row.state) && descendants.has(row.pid) && !row.comm.endsWith('/ps') && row.comm !== 'ps')
  return { processes: kept.length, residentMB: Math.round(kept.reduce((sum, row) => sum + row.rss, 0) / 1024) }
}
const sessions = []
try {
  await deadline(runtime.start())
  await deadline(runtime.defaultSessionOptions(join(home, 'work')))
  for (let n = 1; n <= 8; n++) {
    sessions.push(await deadline(runtime.createSession({ cwd: join(home, 'work') })))
    if ([1, 3, 8].includes(n)) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      console.log(JSON.stringify({ sessions: n, ...snapshot() }))
    }
  }
  for (const session of sessions) await deadline(session.close())
  // Observe the CLI's asynchronous exit after its close acknowledgement.
  await new Promise(resolve => setTimeout(resolve, 1_000))
  console.log(JSON.stringify({ sessions: 'closed', ...snapshot() }))
} catch (error) {
  // Diagnostics from a real agent can contain identities; publish only the stage and kind.
  console.log(JSON.stringify({ opened: sessions.length, unavailable: error.message === 'deadline' ? 'deadline' : /auth|sign.?in|log.?in/i.test(error.message) ? 'authentication' : 'refused', ...snapshot() }))
} finally {
  await runtime.dispose()
  console.log(JSON.stringify({ sessions: 'disposed', ...snapshot() }))
  await rm(home, { recursive: true, force: true })
}
