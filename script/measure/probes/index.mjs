import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
let registerProbe
let run
let createPromptBudget

const CATALOGUE_PROMPT = 'Answer with one JSON object and nothing else: {"rules":[...],"skills":[{"name":...,"description":...}],"mcp":[...]}. In rules put every line of your instructions or context that ends in _SENTINEL, verbatim. In skills list every skill whose name starts with measure- with its description verbatim. In mcp list the names of the MCP servers you can use.'
const REFRESH_PROMPT = 'Answer with one JSON object with only a description field and nothing else. Give the description of the skill named measure-sentinel verbatim.'

// Serialized into the isolated driver. Only these fixed strings escape it;
// an error's message and data are used in memory and never returned or logged.
export function classifyRequestError(error, codex = false) {
  const classes = { '-32700': 'parse-error', '-32600': 'invalid-request', '-32601': 'method-not-found', '-32602': 'invalid-params', '-32603': 'internal-error', '-32800': 'cancelled', '-32002': 'resource-not-found' }
  const code = Number.isInteger(error?.code) ? error.code : null
  const authentication = !codex && code === -32000
  const errorClass = authentication ? 'authentication-required' : classes[code] ?? (code >= -32099 && code <= -32000 ? 'server-error' : 'unknown')
  const text = JSON.stringify(error ?? {}).toLowerCase()
  const reason = authentication || /authentication|unauthori[sz]ed|sign[ -]?in|log[ -]?in|credential|api[ _-]?key|keychain/.test(text)
    ? 'sign-in not reachable under the approved profile'
    : /quota|rate[ _-]?limit|insufficient.*credit|billing/.test(text) ? 'quota'
    : /network|econn|enotfound|eai_again|fetch failed|connection|dns|socket|connect.*refused/.test(text) ? 'network refused'
    : 'unknown'
  return { reason, errorClass }
}

// Runs inside the isolated harness child. Vendor answers and diagnostics never
// leave this process: only exact fixture matches cross back to the parent.
const modelDriver = async (config, budgetFactory, classifyError) => {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const { writeFileSync } = await import('node:fs')
  const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
  const lines = createInterface({ input: child.stdout })
  const takePrompt = budgetFactory()
  const pending = new Map()
  let id = 0
  let sessionId
  let text = ''
  let finishTurn
  let promptCount = 0
  let refreshed = false
  let output = { status: 'could-not-ask', reason: 'model launch unavailable', rawAnswer: '' }
  const failPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('model launch unavailable'))
    pending.clear()
    finishTurn?.reject(new Error('model launch unavailable'))
  }
  child.on('error', failPending)
  child.on('exit', failPending)
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      // No tool, filesystem, terminal or permission request is executed here.
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not available' } })}\n`)
      return
    }
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      if (message.error) {
        const failure = classifyError(message.error, config.codex)
        waiter.reject(Object.assign(new Error(failure.reason), { failure: { stage: waiter.stage, errorClass: failure.errorClass } }))
      }
      else waiter.resolve(message.result)
    }
    if (config.codex && message.params?.threadId === sessionId) {
      if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string') text += message.params.delta
      if (message.method === 'turn/completed') {
        if (message.params.turn?.status === 'completed') finishTurn?.resolve()
        else finishTurn?.reject(new Error('model request unavailable'))
      }
    } else if (!config.codex && message.method === 'session/update' && message.params?.sessionId === sessionId && message.params.update?.sessionUpdate === 'agent_message_chunk') {
      const content = message.params.update.content
      if (content?.type === 'text' && typeof content.text === 'string') text += content.text
    }
    if (text.length > 1_000_000) {
      text = ''
      failPending()
    }
  })
  const request = (method, params, timeoutMs = 12000) => new Promise((resolve, reject) => {
    if (method === 'session/prompt' || method === 'turn/start') promptCount = takePrompt()
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(method === 'session/prompt' || method === 'turn/start' ? 'prompt timed out' : 'model request unavailable')) }, timeoutMs)
    const stage = method === 'initialize' ? 'initialize' : ['session/new', 'thread/start'].includes(method) ? 'session-new' : 'prompt'
    pending.set(requestId, { stage, resolve: (result) => { clearTimeout(timer); resolve(result) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  })
  const prompt = async (words) => {
    text = ''
    if (!config.codex) {
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: words }] }, config.promptTimeoutMs)
      if (result?.stopReason !== 'end_turn') throw new Error('model request unavailable')
    } else {
      let timer
      const completion = new Promise((resolve, reject) => {
        finishTurn = { resolve, reject }
        timer = setTimeout(() => reject(new Error('prompt timed out')), config.promptTimeoutMs)
      })
      // Observe completion immediately; notifications can arrive with the RPC answer.
      const started = request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: words }], approvalPolicy: 'never' }, config.promptTimeoutMs)
      try { await Promise.all([started, completion]) } finally { clearTimeout(timer); finishTurn = null }
    }
    try { return JSON.parse(text) } catch { return null }
  }
  const catalogue = (value) => {
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'mcp,rules,skills'
      || !Array.isArray(value.rules) || !Array.isArray(value.skills) || !Array.isArray(value.mcp)
      || [value.rules, value.skills, value.mcp].some((list) => list.length > 500)
      || !value.rules.every((rule) => typeof rule === 'string') || !value.mcp.every((name) => typeof name === 'string')
      || !value.skills.every((skill) => skill && Object.keys(skill).sort().join(',') === 'description,name' && typeof skill.name === 'string' && typeof skill.description === 'string')) return null
    const rules = value.rules.flatMap((sentinel) => config.rules.filter((rule) => rule.sentinel === sentinel))
    const skills = value.skills.flatMap((skill) => config.skills.filter((entry) => entry.name === skill.name && (entry.sentinel ?? '') === skill.description))
    return { rules, skills, mcp: [...new Set(value.mcp.filter((name) => name === 'measure_fixture'))] }
  }
  const summarize = (observed) => {
    const reported = [...new Set(observed.skills.map((entry) => entry.name))]
    const duplicate = observed.skills.filter((entry) => entry.name === 'measure-duplicate')
    const seenRoots = new Set()
    const skillRoots = observed.skills.flatMap((entry) => {
      if (!entry.sentinel || seenRoots.has(entry.path)) return []
      seenRoots.add(entry.path)
      return [{ path: entry.path, scope: entry.scope }]
    })
    const rawAnswer = [...new Set([...observed.rules.map((rule) => rule.sentinel), ...observed.skills.flatMap((entry) => [entry.name, entry.sentinel].filter(Boolean)), ...observed.mcp])].join('\n')
    if (!rawAnswer) throw new Error('answer failed the fixture-only privacy allowlist')
    return { status: 'asked', rawAnswer, facts: {
      rulesFiles: { status: 'asked', reported: observed.rules }, catalogue: { reported }, reportsCatalogue: true,
      precedence: { reported: duplicate.map((entry) => entry.sentinel), duplicateCount: duplicate.length },
      rejections: { missingDescriptionListed: reported.includes('measure-no-description'), oversizedListed: reported.includes('measure-oversized') }, reportsRejections: false,
      skillRoots, mcp: { status: 'asked', reported: observed.mcp },
      refresh: { catalogueRefresh: 'none', skillToggle: false, openSessionSeesChange: 'unknown' }, signedOutCatalogue: { status: 'unknown' },
    } }
  }
  try {
    await request('initialize', config.codex
      ? { clientInfo: { name: 'harnessdesk-measure', version: '1.0.0' }, capabilities: { experimentalApi: true } }
      : { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'harnessdesk-measure', title: 'HarnessDesk', version: '1.0.0' } })
    if (config.codex) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
    const opened = await request(config.codex ? 'thread/start' : 'session/new', config.codex
      ? { cwd: config.cwd, approvalPolicy: 'never', sandbox: 'read-only' }
      : { cwd: config.cwd, mcpServers: config.handshakeOnly ? [] : [{ name: 'measure_fixture', command: 'node', args: [config.mcpPeer], env: [] }] })
    sessionId = config.codex ? opened?.thread?.id : opened?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('model request unavailable')
    if (config.handshakeOnly) {
      output = { status: 'asked', rawAnswer: '', facts: { signedOutCatalogue: { status: 'unknown', observation: 'session-created' } } }
      return { ...output, prompted: false, refreshed: false }
    }
    let observed = catalogue(await prompt(config.cataloguePrompt))
    if (observed) output = summarize(observed)
    let refreshObservation = 'unknown'
    const changed = observed?.skills.find((entry) => entry.name === 'measure-sentinel' && entry.sentinel)
      ?? config.skills.findLast((entry) => entry.name === 'measure-sentinel' && entry.scope === 'project' && entry.sentinel)
    if (changed) {
      const path = config.skillFiles.find((entry) => entry.path === changed.path && entry.scope === changed.scope)?.file
      if (!path) throw new Error('model request unavailable')
      writeFileSync(path, `---\nname: measure-sentinel\ndescription: REFRESHED_SENTINEL\n---\n\nFixture changed in the open session.\n`)
      refreshed = true
      config.skills.push({ ...changed, sentinel: 'REFRESHED_SENTINEL' })
      const answer = await prompt(config.refreshPrompt)
      if (!answer || Array.isArray(answer) || Object.keys(answer).join(',') !== 'description' || typeof answer.description !== 'string') throw new Error('answer not requested JSON')
      refreshObservation = answer.description === 'REFRESHED_SENTINEL' ? 'yes' : answer.description === changed.sentinel ? 'no' : 'unknown'
    }
    // The third slot is reserved exclusively for a malformed first answer.
    if (!observed) observed = catalogue(await prompt(config.cataloguePrompt))
    if (!observed) throw new Error('answer not requested JSON')
    output = summarize(observed)
    output.facts.refresh.openSessionSeesChange = refreshObservation
  } catch (error) {
    const reasons = ['prompt cap reached', 'prompt timed out', 'model launch unavailable', 'model request unavailable', 'answer not requested JSON', 'answer failed the fixture-only privacy allowlist', 'sign-in not reachable under the approved profile', 'network refused', 'quota', 'unknown']
    output = { ...output, status: 'could-not-ask', reason: reasons.includes(error.message) ? error.message : 'model request unavailable', rawAnswer: '' }
    if (error.failure) output.facts = { ...output.facts, requestFailure: error.failure }
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error('model request unavailable'))
    pending.clear()
    lines.close()
    child.stdin.destroy()
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} resolve() }, 1000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    })
  }
  return { ...output, prompted: promptCount > 0, refreshed }
}

async function modelProbe(agent, fixture, options) {
  const codex = agent.id === 'codex'
  const bridge = agent.acp?.bridge
  const envOverrides = { ...(agent.acp?.env ?? {}), ...options.envOverrides }
  const allowedEnv = [...Object.keys(agent.acp?.env ?? {}), ...(options.allowedEnv ?? [])]
  if (bridge?.executableEnv) { envOverrides[bridge.executableEnv] = agent.command; allowedEnv.push(bridge.executableEnv) }
  const config = {
    codex, command: bridge?.command ?? agent.command, args: codex ? ['app-server'] : bridge?.args ?? agent.acp.args,
    handshakeOnly: options.handshakeOnly === true,
    cwd: fixture.nested, mcpPeer: fixture.mcpPeer,
    cataloguePrompt: CATALOGUE_PROMPT, refreshPrompt: REFRESH_PROMPT, promptTimeoutMs: options.promptTimeoutMs ?? 90_000,
    skills: fixture.skillEntries,
    rules: Object.entries(fixture.ruleSentinels).map(([path, sentinel]) => ({
      path: path.startsWith(`${fixture.home}/`) ? `~/${path.slice(fixture.home.length + 1)}` : `./${path.slice(fixture.repo.length + 1)}`,
      scope: path.startsWith(`${fixture.home}/`) ? 'user' : 'project', sentinel,
    })),
    skillFiles: fixture.skillEntries.filter((entry) => entry.name === 'measure-sentinel').map((entry) => ({ path: entry.path, scope: entry.scope, file: join(entry.scope === 'user' ? fixture.home : fixture.repo, entry.path.replace(/^~\//, ''), 'measure-sentinel/SKILL.md') })),
  }
  const driver = `(${modelDriver.toString()})(${JSON.stringify(config)},${createPromptBudget.toString()},${classifyRequestError.toString()}).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exit(2))`
  const execution = await run(process.execPath, ['-e', driver], fixture, { timeoutMs: 300_000, envOverrides, allowedEnv })
  if (execution.code !== 0) return { status: 'could-not-ask', reason: 'model launch unavailable' }
  let result
  try { result = JSON.parse(execution.stdout) } catch { return { status: 'could-not-ask', reason: 'model request unavailable' } }
  const prompted = result.prompted === true
  if (result.refreshed === true) fixture.refreshTokens = ['REFRESHED_SENTINEL']
  delete result.refreshed
  delete result.prompted
  Object.defineProperty(result, 'prompted', { value: prompted })
  return Object.assign(result, { interface: options.handshakeOnly ? 'ACP initialize and session request' : codex ? 'app-server model prompt' : 'ACP model prompt', question: options.handshakeOnly ? 'session created while signed out' : 'rules catalogue precedence rejections refresh mcp' })
}

// Diagnostic only: shares the ask startup and error reducer, then stops before
// the first prompt. The caller must prepare the approved profile before run.
export function probeAcpHandshake(agent, fixture) {
  return modelProbe(agent, fixture, { handshakeOnly: true })
}

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
  const initialize = messages.find((message) => message.id === 1)
  const newSession = messages.find((message) => message.id === 2)
  const commandUpdate = messages.find((message) => message.method === 'session/update' && message.params?.update?.sessionUpdate === 'available_commands_update')
  const commands = commandUpdate?.params?.update?.availableCommands ?? []
  const initialized = Boolean(initialize?.result)
  const sessionCreated = Boolean(newSession?.result)
  const signedOutFailure = Boolean(initialize?.error || newSession?.error)
  const signedOutObservation = sessionCreated ? 'session-created' : signedOutFailure ? 'no-session' : 'unknown'
  return {
    initialized, sessionCreated, signedOutFailure, commandCount: Array.isArray(commands) ? commands.length : 0, signedOutObservation,
    initializeAnswered: Boolean(initialize), sessionNewAnswered: Boolean(newSession),
    signInMethodCount: Array.isArray(initialize?.result?.authMethods) ? initialize.result.authMethods.length : 0,
    ...(Number.isInteger(initialize?.error?.code) ? { initializeErrorCode: initialize.error.code } : {}),
    ...(Number.isInteger(newSession?.error?.code) ? { sessionNewErrorCode: newSession.error.code } : {}),
  }
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
  const { resolve } = await import('node:path')
  cwd = resolve(cwd)
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
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'harnessdesk-measure', title: 'HarnessDesk', version: '1.0.0' } })
    if (initialized.error) return messages
    await request('session/new', { cwd, mcpServers: [] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return messages
  } catch (error) {
    // A timeout must not erase an earlier answer, including a refusal.
    if (error.message === 'timeout') return messages
    throw error
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

async function codexProbe(agent, fixture, options) {
  if (options?.ask) return modelProbe(agent, fixture, options)
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

async function acpProbe(agent, fixture, options) {
  if (options?.ask) return modelProbe(agent, fixture, options)
  const bridge = agent.acp.bridge
  const command = bridge?.command ?? agent.command
  const args = bridge ? bridge.args : agent.acp.args
  const envOverrides = { ...(agent.acp.env ?? {}) }
  const allowedEnv = Object.keys(envOverrides)
  if (bridge?.executableEnv) {
    envOverrides[bridge.executableEnv] = agent.command
    allowedEnv.push(bridge.executableEnv)
  }
  const driver = `(${acpDriver.toString()})(${JSON.stringify(command)},${JSON.stringify(args)},${JSON.stringify(fixture.repo)}).then(x=>process.stdout.write(x.map(message=>JSON.stringify(message)).join('\\n'))).catch(()=>process.exit(2))`
  const execution = await run(process.execPath, ['-e', driver], fixture, { timeoutMs: 30_000, envOverrides, allowedEnv })
  const summary = summarizeAcpMessages(parseAcpOutput(execution.stdout))
  const modelReasons = {
    rulesFiles: { status: 'could-not-ask' }, catalogue: { status: 'could-not-ask' },
    reportsCatalogue: false, reportsRejections: false,
    precedence: { status: 'could-not-ask' }, rejections: { status: 'could-not-ask' },
    skillRoots: [], refresh: { status: 'unknown', catalogueRefresh: 'none', skillToggle: false, openSessionSeesChange: 'unknown' }, mcp: { status: 'unknown' },
    signedOutCatalogue: {
      status: 'unknown', observation: summary.signedOutObservation,
      initializeAnswered: summary.initializeAnswered, sessionNewAnswered: summary.sessionNewAnswered,
      signInMethodCount: summary.signInMethodCount,
      ...(summary.initializeErrorCode !== undefined ? { initializeErrorCode: summary.initializeErrorCode } : {}),
      ...(summary.sessionNewErrorCode !== undefined ? { sessionNewErrorCode: summary.sessionNewErrorCode } : {}),
    },
  }
  if (['session-created', 'no-session'].includes(summary.signedOutObservation)) return {
    interface: 'ACP initialize and session request', question: summary.signedOutObservation === 'no-session' ? 'no session while signed out' : 'session created while signed out', facts: modelReasons,
    rawAnswer: '', status: 'asked',
  }
  const reason = execution.code !== 0 ? 'ACP launch unavailable' : summary.initializeAnswered ? 'ACP session request unavailable' : 'ACP initialize unavailable'
  return { interface: 'ACP initialize and session request', question: 'no session while signed out', facts: modelReasons, status: 'could-not-ask', reason }
}

export function installProbes(harness) {
  registerProbe = harness.registerProbe
  run = harness.run
  createPromptBudget = harness.createPromptBudget
  registerProbe('codex', codexProbe)
  for (const id of ['gemini', 'openclaw', 'opencode', 'cline', 'hermes', 'codebuddy-code', 'kimi', 'pi-acp', 'grok-build', 'github-copilot-cli', 'antigravity-acp', 'claude-code', 'cursor', 'dsh', 'devin']) {
    registerProbe(id, acpProbe)
  }
}
