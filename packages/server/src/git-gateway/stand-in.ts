import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseGitWrite } from '@harnessdesk/protocol/git-steer'

export const GIT_STEER_UNREACHABLE = 'HarnessDesk: pushes from this conversation go through the git_push tool; use it instead.'
interface Reply { action: 'done' | 'own'; ok?: boolean; output?: string; ticket?: string }
const call = (params: Record<string, unknown>): Promise<Reply> => new Promise((resolve, reject) => {
  const socket = connect(process.env['HD_TOOLS_SOCKET'] ?? '')
  let text = '', settled = false
  const finish = (error?: Error, reply?: Reply) => {
    if (settled) return
    settled = true; socket.destroy()
    if (error) reject(error); else resolve(reply!)
  }
  // Approval may remain open for ten minutes. A closed or unreachable socket
  // fails immediately; a silent connection is bounded as well.
  socket.setTimeout(11 * 60_000, () => finish(new Error('steer-timeout')))
  socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, method: 'git/steer', params: { ...params, caller: process.env['HD_GIT_CALLER'] } })}\n`))
  socket.on('data', data => {
    text += data.toString()
    const lf = text.indexOf('\n'); if (lf < 0) return
    try {
      const result = JSON.parse(text.slice(0, lf)) as { result?: Reply; error?: { message?: string } }
      if (result.error || !result.result) finish(new Error(result.error?.message ?? 'bad-steer-reply'))
      else finish(undefined, result.result)
    } catch (error) { finish(error as Error) }
  })
  socket.on('error', error => finish(error))
  socket.on('close', () => { if (!settled) finish(new Error('steer-closed')) })
})
async function real(binary: string, argv: readonly string[]): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  const path = process.env[binary === 'git' ? 'HD_GIT_REAL_GIT' : 'HD_GIT_REAL_GH']
  if (!path) { process.stderr.write(`HarnessDesk: the real ${binary} executable was not found.\n`); return { code: 1, signal: null } }
  try { if (dirname(realpathSync(path)).endsWith('/git-steer-bin') || readFileSync(path).subarray(0, 256).toString().includes('HARNESSDESK_GIT_STAND_IN')) throw new Error('recursive stand-in') } catch { process.stderr.write('HarnessDesk: refusing a recursive or unavailable git stand-in.\n'); return { code: 1, signal: null } }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HD_TOOLS_') && key !== 'HD_GIT_CALLER'))
  return new Promise(resolve => {
    const child = spawn(path, [...argv], { stdio: 'inherit', env })
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const handlers = signals.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return handler })
    const clean = () => signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!))
    child.once('error', error => { clean(); process.stderr.write(`${error.message}\n`); resolve({ code: 1, signal: null }) })
    child.once('exit', (code, signal) => { clean(); resolve({ code: code ?? 1, signal }) })
  })
}
export async function runGitStandIn(binary: string, argv: readonly string[]): Promise<void> {
  const parsed = parseGitWrite(binary, argv)
  let result: { code: number; signal: NodeJS.Signals | null }
  if (!parsed) result = await real(binary, argv)
  else {
    let reply: Reply
    try { reply = await call({ binary, argv, cwd: process.cwd() }) }
    catch { process.stderr.write(`${GIT_STEER_UNREACHABLE}\n`); process.exitCode = 1; return }
    if (reply.output) process.stdout.write(`${reply.output}\n`)
    if (reply.action === 'own') {
      result = await real(binary, argv)
      if (reply.ticket) try { const recorded = await call({ ticket: reply.ticket, exitCode: result.code }); if (recorded.output) process.stdout.write(`${recorded.output}\n`) }
      catch { process.stderr.write('HarnessDesk: own git finished, but its result could not be recorded.\n') }
    } else result = { code: reply.ok ? 0 : 1, signal: null }
  }
  if (result.signal) { process.kill(process.pid, result.signal); return }
  process.exitCode = result.code
}
