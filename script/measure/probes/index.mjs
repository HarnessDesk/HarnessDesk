import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
let registerProbe
let run

export function parseCodexOutput(text) {
  const messages = []
  for (const line of String(text).split(/\r?\n/)) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && ('id' in value || 'method' in value)) messages.push(value)
    } catch { /* app-server diagnostics are not protocol records */ }
  }
  return messages
}

export function parseAcpOutput(text) {
  const messages = []
  for (const line of String(text).split(/\r?\n/)) {
    try {
      const message = JSON.parse(line)
      if (message && typeof message === 'object' && ('id' in message || 'method' in message)) messages.push(message)
    } catch { /* ignore startup diagnostics */ }
  }
  return messages
}

export function summarizeAcpMessages(messages) {
  const newSession = messages.find((message) => message.id === 2)
  const commandUpdate = messages.find((message) => message.method === 'session/update' && message.params?.update?.sessionUpdate === 'available_commands_update')
  const commands = commandUpdate?.params?.update?.availableCommands ?? []
  const initialized = messages.some((message) => message.id === 1 && !message.error)
  const sessionCreated = Boolean(newSession?.result)
  const signedOutFailure = Boolean(newSession?.error)
  const signedOutObservation = sessionCreated ? 'session-created' : signedOutFailure ? 'no-session' : 'unknown'
  return { initialized, sessionCreated, signedOutFailure, commandCount: Array.isArray(commands) ? commands.length : 0, signedOutObservation }
}

export function parseRejectionWords(errors) {
  const messages = errors.map((error) => String(error?.message ?? ''))
  return {
    description: messages.some((message) => /description/i.test(message)),
    size: messages.some((message) => /size|large|limit|too many|exceed/i.test(message)),
    manifest: messages.some((message) => /manifest|metadata|invalid/i.test(message)),
  }
}

const acpDriver = async (command, args, cwd) => {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
  const lines = createInterface({ input: child.stdout })
  const messages = []
  const waiters = new Map()
  let nextId = 0
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    messages.push(message)
    if (message.id !== undefined && waiters.has(message.id)) {
      waiters.get(message.id)(message)
      waiters.delete(message.id)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error('timeout')) }, 12000)
    waiters.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {}, clientInfo: { name: 'harnessdesk-measure', title: 'HarnessDesk', version: '1.0.0' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
    await request('session/new', { cwd, mcpServers: [] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return messages
  } finally {
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.stdin.end()
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
    lines.close()
  }
}

const appServerDriver = async (binary, cwd, changedSkill) => {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const { writeFileSync } = await import('node:fs')
  const child = spawn(binary, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
  const lines = createInterface({ input: child.stdout })
  const waiting = new Map()
  let id = 0
  let stage = 'spawn'
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message)
      waiting.delete(message.id)
    }
  })
  const request = (method, params = {}, timeoutMs = 12000) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timeout = setTimeout(() => { waiting.delete(requestId); reject(new Error('rpc-timeout')) }, timeoutMs)
    waiting.set(requestId, (message) => { clearTimeout(timeout); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  })
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  try {
    stage = 'initialize'
    const initialized = await request('initialize', { clientInfo: { name: 'harnessdesk-measure', title: 'HarnessDesk', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] } })
    notify('initialized')
    stage = 'skills-before'
    const before = await request('skills/list', { cwds: [cwd] })
    writeFileSync(changedSkill, `---\nname: measure-sentinel\ndescription: REFRESHED_SENTINEL\n---\n\nFixture changed after initial catalogue read.\n`)
    stage = 'skills-after'
    const after = await request('skills/list', { cwds: [cwd], forceReload: true })
    stage = 'runtime-refresh'
    const refresh = await request('runtime/refreshCatalog', {})
    stage = 'config-read'
    const config = await request('config/read', { cwd, includeLayers: true })
    stage = 'mcp-status'
    let mcp
    try { mcp = await request('mcpServerStatus/list', { detail: 'full' }, 4000) } catch { mcp = { error: { code: 'timeout' } } }
    return { initialized, before, after, refresh, config, mcp }
  } catch {
    return { failureStage: stage }
  } finally {
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.stdin.end()
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
    lines.close()
  }
}

function resultOf(message) { return message && !message.error ? message.result : null }
function skillsIn(message) {
  const result = resultOf(message)
  return (result?.data ?? []).flatMap((entry) => entry?.skills ?? [])
}

async function codexProbe(agent, fixture) {
  const changedSkill = join(fixture.repo, '.codex/skills/measure-sentinel/SKILL.md')
  const driver = `(${appServerDriver.toString()})(${JSON.stringify(agent.command)},${JSON.stringify(fixture.repo)},${JSON.stringify(changedSkill)}).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exit(2))`
  const execution = await run(process.execPath, ['-e', driver], fixture, { timeoutMs: 45_000 })
  if (execution.code !== 0) return { status: 'could-not-ask', reason: 'app-server could not answer safely' }
  let parsed
  try { parsed = JSON.parse(execution.stdout) } catch { parsed = null }
  if (parsed?.failureStage) {
    const reason = {
      initialize: 'app-server initialize unavailable', 'skills-before': 'app-server skills list unavailable',
      'skills-after': 'app-server refresh list unavailable', 'runtime-refresh': 'app-server refresh request unavailable', 'config-read': 'app-server config read unavailable',
      'mcp-status': 'app-server mcp status unavailable', spawn: 'app-server launch unavailable',
    }[parsed.failureStage] ?? 'app-server request unavailable'
    return { status: 'could-not-ask', reason, interface: 'codex app-server skills/list', question: 'catalogue precedence rejections refresh mcp' }
  }
  if (!parsed?.initialized || parsed.initialized.error) return { status: 'could-not-ask', reason: 'app-server initialize unavailable' }
  const initialSkills = skillsIn(parsed.before)
  const refreshedSkills = skillsIn(parsed.after)
  const duplicate = initialSkills.filter((skill) => skill.name === 'measure-duplicate')
  const errors = (resultOf(parsed.before)?.data ?? []).flatMap((entry) => entry?.errors ?? [])
  const mcpStatuses = resultOf(parsed.mcp)?.data ?? []
  const config = resultOf(parsed.config)?.config ?? {}
  const configuredMcp = config.mcp_servers ?? config.mcpServers ?? {}
  const fixtureNames = new Set(['measure-user', 'measure-project', 'measure-duplicate', 'measure-no-description', 'measure-oversized', 'measure-sentinel', 'measure-with-auxiliary'])
  const reportedNames = [...new Set(initialSkills.filter((skill) => fixtureNames.has(skill.name)).map((skill) => skill.name))]
  const sentinelReported = initialSkills.some((skill) => skill.name === 'measure-sentinel')
  const duplicateScope = duplicate.length === 1 && (duplicate[0].scope === 'user' || duplicate[0].scope === 'project') ? duplicate[0].scope : duplicate.length > 1 ? 'unknown' : 'none'
  const refreshed = refreshedSkills.find((skill) => skill.name === 'measure-sentinel')
  const resultFacts = {
    rulesFiles: { status: 'could-not-ask' },
    catalogue: { reported: reportedNames, userPresent: initialSkills.some((skill) => skill.name === 'measure-user'), projectPresent: initialSkills.some((skill) => skill.name === 'measure-project'), auxiliaryPresent: initialSkills.some((skill) => skill.name === 'measure-with-auxiliary') },
    reportsCatalogue: Boolean(resultOf(parsed.before)),
    precedence: { duplicateUserPresent: duplicate.some((skill) => skill.scope === 'user'), duplicateProjectPresent: duplicate.some((skill) => skill.scope === 'repo'), duplicateCount: duplicate.length },
    rejections: { missingDescriptionListed: initialSkills.some((skill) => skill.name === 'measure-no-description'), missingDescriptionError: errors.some((error) => String(error.path).includes('measure-no-description')), oversizedListed: initialSkills.some((skill) => skill.name === 'measure-oversized'), oversizedError: errors.some((error) => String(error.path).includes('measure-oversized')), rejectionWords: parseRejectionWords(errors), errorCount: errors.length },
    reportsRejections: Boolean(resultOf(parsed.before)),
    skillRoots: [
      ...(initialSkills.some((skill) => skill.scope === 'user') ? [{ path: '~/.codex/skills', scope: 'user' }] : []),
      ...(initialSkills.some((skill) => skill.scope === 'repo') ? [{ path: '.codex/skills', scope: 'project' }] : []),
    ],
    refresh: { catalogueRefresh: refreshed?.description === 'REFRESHED_SENTINEL' ? 'live' : 'none', skillToggle: false, forceReloadChangedDescription: refreshed?.description === 'REFRESHED_SENTINEL', runtimeRefreshSupported: Boolean(resultOf(parsed.refresh) && !parsed.refresh.error), runtimeRefreshRejected: Boolean(parsed.refresh?.error), openSessionSeesChange: 'unknown' },
    mcp: { fixtureConfigured: Object.hasOwn(configuredMcp, 'measure_fixture') || (Array.isArray(mcpStatuses) && mcpStatuses.some((status) => status.name === 'measure_fixture')), status: !Array.isArray(mcpStatuses) || !mcpStatuses.length ? 'unknown' : mcpStatuses.some((status) => status.runtimeStatus === 'connected') ? 'connected' : 'disconnected' },
    signedOutCatalogue: { status: initialSkills.length ? 'available' : 'empty' },
  }
  return {
    interface: 'codex app-server skills/list', question: 'catalogue precedence rejections refresh mcp',
    rawAnswer: sentinelReported ? 'measure-sentinel' : reportedNames[0] ?? '', facts: resultFacts,
    status: sentinelReported || reportedNames.length ? 'asked' : 'could-not-ask', reason: 'app-server returned no fixture skills',
  }
}

async function acpProbe(agent, fixture) {
  const bridge = agent.acp.bridge
  const command = bridge?.command ?? agent.command
  const args = bridge ? bridge.args : agent.acp.args
  const envOverrides = { ...(agent.acp.env ?? {}) }
  const allowedEnv = Object.keys(envOverrides)
  if (bridge?.executableEnv) {
    envOverrides[bridge.executableEnv] = agent.command
    allowedEnv.push(bridge.executableEnv)
  }
  const driver = `(${acpDriver.toString()})(${JSON.stringify(command)},${JSON.stringify(args)},${JSON.stringify(fixture.repo)}).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exit(2))`
  const execution = await run(process.execPath, ['-e', driver], fixture, { timeoutMs: 25_000, envOverrides, allowedEnv })
  const summary = summarizeAcpMessages(parseAcpOutput(execution.stdout))
  const modelReasons = {
    rulesFiles: { status: 'could-not-ask' }, catalogue: { status: 'could-not-ask' },
    reportsCatalogue: false, reportsRejections: false,
    precedence: { status: 'could-not-ask' }, rejections: { status: 'could-not-ask' },
    skillRoots: [], refresh: { status: 'unknown', catalogueRefresh: 'none', skillToggle: false, openSessionSeesChange: 'unknown' }, mcp: { status: 'unknown' },
    signedOutCatalogue: { status: 'unknown', observation: summary.signedOutObservation },
  }
  if (summary.initialized && ['session-created', 'no-session'].includes(summary.signedOutObservation)) return {
    interface: 'ACP session/new', question: summary.signedOutObservation === 'no-session' ? 'no session while signed out' : 'session created while signed out', facts: modelReasons,
    rawAnswer: '', status: 'asked',
  }
  const reason = 'ACP initialize unavailable'
  return { interface: 'ACP session/new', question: 'no session while signed out', facts: modelReasons, status: 'could-not-ask', reason }
}

export function installProbes(harness) {
  registerProbe = harness.registerProbe
  run = harness.run
  registerProbe('codex', codexProbe)
  for (const id of ['gemini', 'openclaw', 'opencode', 'cline', 'hermes', 'codebuddy-code', 'kimi', 'pi-acp', 'grok-build', 'github-copilot-cli', 'antigravity-acp', 'claude-code', 'cursor', 'dsh', 'devin']) {
    registerProbe(id, acpProbe)
  }
}
