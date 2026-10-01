import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESULT_DIR = new URL('../../docs/verification/library-measurements/', import.meta.url)
const RESULT_DIR_PATH = fileURLToPath(RESULT_DIR)
const VENDOR_HOMES = [
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CURSOR_CONFIG_DIR',
  'OPENCLAW_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HERMES_HOME',
  'CODEBUDDY_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'GROK_HOME', 'COPILOT_HOME',
  'GEMINI_HOME', 'DSH_HOME', 'OPENCLAW_CONFIG_PATH', 'OPENCODE_CONFIG_DIR',
]
const PROBES = new Map()
const KNOWN_SKILL_ROOTS = {
  claudecode: { user: ['~/.claude/skills'], project: ['.claude/skills'] },
  cursor: { user: ['~/.cursor/skills', '~/.cursor/skills-cursor'], project: ['.cursor/skills'] },
  geminicli: { user: ['~/.gemini/skills'], project: ['.gemini/skills'] },
  deepseek: { user: ['~/.dsh/skills'], project: ['.dsh/skills'] },
}
const REAL_HOME_BLOCKS = [
  '.harnessdesk', '.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.agents', '.dsh',
  '.openclaw', '.hermes', '.codebuddy', '.kimi', '.pi', '.grok', '.copilot',
  '.antigravity', '.devin', '.cline', '.local/share', '.config', '.ssh', '.aws',
  '.azure', '.kube', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki',
  '.git-credentials', 'Library/Keychains', 'Library/Application Support',
]

const write = async (path, body) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

const skillBody = (name, description, extra = '') =>
  `---\nname: ${name}\n${description === null ? '' : `description: ${description}\n`}---\n\n${extra || `Fixture for ${name}.`}\n`

export async function createFixture(root) {
  root ??= await mkdtemp('/tmp/hd-measure-')
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const nested = join(repo, 'nested')
  const fixture = {
    root, home, repo, nested,
    harnessHome: join(home, 'harnessdesk'),
    isolation: { available: process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'), reason: '' },
    skills: {
      user: join(home, '.codex/skills/measure-user'),
      project: join(repo, '.codex/skills/measure-project'),
      duplicateUser: join(home, '.codex/skills/measure-duplicate'),
      duplicateProject: join(repo, '.codex/skills/measure-duplicate'),
      missingDescription: join(repo, '.codex/skills/measure-no-description'),
      oversized: join(repo, '.codex/skills/measure-oversized'),
      sentinel: join(repo, '.codex/skills/measure-sentinel'),
      auxiliary: join(repo, '.codex/skills/measure-with-auxiliary'),
    },
    ruleSentinels: {},
    mcp: [join(home, '.codex/config.toml'), join(repo, '.cursor/mcp.json')],
    mcpPeer: join(root, 'fixture-mcp.mjs'),
  }
  await Promise.all([home, repo, nested].map((path) => mkdir(path, { recursive: true })))
  for (const [path, name, description] of [
    [fixture.skills.user, 'measure-user', 'user scope fixture'],
    [fixture.skills.project, 'measure-project', 'project scope fixture'],
    [fixture.skills.duplicateUser, 'measure-duplicate', 'USER_COPY_SENTINEL'],
    [fixture.skills.duplicateProject, 'measure-duplicate', 'PROJECT_COPY_SENTINEL'],
    [fixture.skills.missingDescription, 'measure-no-description', null],
    [fixture.skills.oversized, 'measure-oversized', 'oversized fixture'],
    [fixture.skills.sentinel, 'measure-sentinel', 'unique catalogue sentinel'],
    [fixture.skills.auxiliary, 'measure-with-auxiliary', 'auxiliary file fixture'],
  ]) {
    await write(join(path, 'SKILL.md'), skillBody(name, description,
      path === fixture.skills.oversized ? 'x'.repeat(1_100_000) : undefined))
  }
  await write(join(fixture.skills.auxiliary, 'references', 'measure-reference.md'), 'AUXILIARY_FILE_SENTINEL\n')
  const ruleFiles = [
    [join(home, 'AGENTS.md'), 'HOME_AGENTS_SENTINEL'],
    [join(home, 'CLAUDE.md'), 'HOME_CLAUDE_SENTINEL'],
    [join(home, 'GEMINI.md'), 'HOME_GEMINI_SENTINEL'],
    [join(home, '.cursor/rules/home.mdc'), 'HOME_CURSOR_RULE_SENTINEL'],
    [join(repo, 'AGENTS.md'), 'REPO_AGENTS_SENTINEL'],
    [join(repo, 'CLAUDE.md'), 'REPO_CLAUDE_SENTINEL'],
    [join(repo, 'GEMINI.md'), 'REPO_GEMINI_SENTINEL'],
    [join(repo, '.cursor/rules/repo.mdc'), 'REPO_CURSOR_RULE_SENTINEL'],
    [join(nested, 'AGENTS.md'), 'NESTED_AGENTS_SENTINEL'],
    [join(nested, 'CLAUDE.md'), 'NESTED_CLAUDE_SENTINEL'],
    [join(nested, 'GEMINI.md'), 'NESTED_GEMINI_SENTINEL'],
    [join(nested, '.cursor/rules/nested.mdc'), 'NESTED_CURSOR_RULE_SENTINEL'],
  ]
  for (const [path, phrase] of ruleFiles) {
    fixture.ruleSentinels[path] = phrase
    await write(path, `# Fixture rules\n\n${phrase}\n`)
  }
  await write(fixture.mcpPeer, `import { createInterface } from 'node:readline'\nconst io = createInterface({ input: process.stdin })\nio.on('line', line => {\n  const request = JSON.parse(line)\n  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'measure-fixture', version: '1' } } }) + '\\n')\n  else if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\\n')\n})\n`)
  await write(fixture.mcp[0], `[mcp_servers.measure_fixture]\ncommand = "node"\nargs = [${JSON.stringify(fixture.mcpPeer)}]\n`)
  await write(fixture.mcp[1], JSON.stringify({ mcpServers: { measure_fixture: { command: 'node', args: [fixture.mcpPeer] } } }, null, 2))
  await write(join(root, 'tmp/.keep'), '')
  for (const roots of Object.values(KNOWN_SKILL_ROOTS)) await populateSkillRoots(fixture, roots)
  fixture.isolation.reason = fixture.isolation.available ? '' : 'cannot isolate: macOS sandbox-exec unavailable'
  return fixture
}

export async function populateSkillRoots(fixture, roots) {
  const names = ['measure-user', 'measure-project', 'measure-duplicate', 'measure-no-description', 'measure-oversized', 'measure-sentinel', 'measure-with-auxiliary']
  const written = []
  for (const [scope, candidates] of [['user', roots.user], ['project', roots.project]]) {
    for (const path of candidates) {
      const root = path.startsWith('~/') ? join(fixture.home, path.slice(2)) : join(fixture.repo, path)
      for (const name of names) {
        const destination = join(root, name)
        const description = name === 'measure-no-description' ? null : `${scope.toUpperCase()}_${name}_SENTINEL`
        const body = skillBody(name, description, name === 'measure-oversized' ? 'x'.repeat(1_100_000) : undefined)
        await write(join(destination, 'SKILL.md'), body)
        if (name === 'measure-with-auxiliary') await write(join(destination, 'references', 'measure-reference.md'), 'AUXILIARY_FILE_SENTINEL\n')
        written.push({ path, scope, name, sentinel: description })
      }
    }
  }
  return written
}

const isWithin = (root, path) => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

export function assertIsolatedEnv(env, root) {
  for (const name of ['HOME', 'HARNESSDESK_HOME', 'TMPDIR', ...VENDOR_HOMES, 'cwd']) {
    if (!env[name]) throw new Error(`${name} must be set to a path under the temporary root`)
    if (!isWithin(root, env[name])) throw new Error(`${name} resolves outside the temporary root`)
  }
}

export const safeEnv = (fixture, cwd = fixture.repo) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: process.env.LANG ?? 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  HOME: fixture.home,
  CODEX_HOME: join(fixture.home, '.codex'),
  CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'),
  GEMINI_CLI_HOME: join(fixture.home, '.gemini'),
  CURSOR_CONFIG_DIR: join(fixture.home, '.cursor'),
  OPENCLAW_STATE_DIR: join(fixture.home, '.openclaw'),
  XDG_CONFIG_HOME: join(fixture.home, '.config'),
  XDG_DATA_HOME: join(fixture.home, '.local/share'),
  HERMES_HOME: join(fixture.home, '.hermes'),
  CODEBUDDY_CONFIG_DIR: join(fixture.home, '.codebuddy'),
  PI_CODING_AGENT_DIR: join(fixture.home, '.pi'),
  GROK_HOME: join(fixture.home, '.grok'),
  COPILOT_HOME: join(fixture.home, '.copilot'),
  GEMINI_HOME: join(fixture.home, '.gemini-alt'),
  DSH_HOME: join(fixture.home, '.dsh'),
  OPENCLAW_CONFIG_PATH: join(fixture.home, '.openclaw/openclaw.json'),
  OPENCODE_CONFIG_DIR: join(fixture.home, '.config/opencode'),
  HARNESSDESK_HOME: fixture.harnessHome,
  TMPDIR: join(fixture.root, 'tmp'),
  cwd,
})

export function makeSandboxProfile(root, realHome = homedir()) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null
  return sandboxProfileText(realpathSync(realHome))
}

export function verifySandbox(profilePath, fixtureRoot) {
  const canaryHome = join(fixtureRoot, 'sandbox-canary-home')
  const canaryPaths = REAL_HOME_BLOCKS.map((part) => join(canaryHome, part, 'canary'))
  for (const path of canaryPaths) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'sandbox denial canary')
  }
  const canaryProfile = join(fixtureRoot, 'sandbox-canary.sb')
  writeFileSync(canaryProfile, sandboxProfileText(realpathSync(canaryHome)))
  const checkScript = `
    const fs = require('node:fs');
    const paths = process.argv.slice(1);
    for (const path of paths) {
      let readDenied = false, writeDenied = false;
      try { fs.readFileSync(path); } catch (error) { readDenied = ['EPERM', 'EACCES'].includes(error.code); }
      try { fs.writeFileSync(path, 'must be denied'); } catch (error) { writeDenied = ['EPERM', 'EACCES'].includes(error.code); }
      if (!readDenied || !writeDenied) process.exit(31);
    }
  `
  const paths = spawnSync('/usr/bin/sandbox-exec', ['-f', canaryProfile, process.execPath, '-e', checkScript, ...canaryPaths], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  })
  if (paths.status !== 0) return false
  // A canary that does not exist fails with or without the sandbox, which
  // proves nothing. Plant a real item, prove it reads outside the sandbox,
  // prove it is refused inside, and always remove it.
  const service = `harnessdesk-measure-canary-${process.pid}`
  const security = (args, sandboxed) => spawnSync(
    sandboxed ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
    sandboxed ? ['-f', profilePath, '/usr/bin/security', ...args] : args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
  )
  if (security(['add-generic-password', '-s', service, '-a', 'canary', '-w', 'canary'], false).status !== 0) return false
  try {
    const outside = security(['find-generic-password', '-s', service], false)
    const inside = security(['find-generic-password', '-s', service], true)
    if (outside.status !== 0) return false
    return inside.status !== 0
  } finally {
    security(['delete-generic-password', '-s', service], false)
  }
}

export function sandboxProfileText(realHome) {
  const blocked = [...REAL_HOME_BLOCKS.map((path) => join(realHome, path)), '/Library/Keychains', '/System/Library/Keychains']
  const denies = blocked.map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join('\n')
  return `(version 1)\n(allow default)\n${denies}\n(deny mach-lookup (global-name "com.apple.securityd"))\n(deny mach-lookup (global-name "com.apple.SecurityServer"))\n`
}

export function run(command, args, fixture, { cwd = fixture.repo, timeoutMs = 60_000, input = '', envOverrides = {}, allowedEnv = [] } = {}) {
  if (Object.keys(envOverrides).some((name) => !allowedEnv.includes(name))) throw new Error('subprocess environment override is not allowlisted')
  const env = { ...safeEnv(fixture), ...envOverrides, cwd }
  assertIsolatedEnv(env, fixture.root)
  const profile = makeSandboxProfile(fixture.root)
  if (!profile) throw new Error('cannot isolate')
  const profilePath = join(fixture.root, 'probe.sb')
  const sandboxEnv = { ...env, cwd: fixture.repo }
  return writeFile(profilePath, profile).then(() => new Promise((resolveRun, rejectRun) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, command, ...args], {
      cwd: fixture.repo, env: sandboxEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.stdin.end(input)
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr })
    })
  }))
}

export async function captureHelpVersion(agent, fixture) {
  const help = await run(agent.command, ['--help'], fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.help.txt`), `${help.stdout}${help.stderr}`)
  const versionArgs = agent.cli?.versionArgs ?? ['--version']
  const version = await run(agent.command, versionArgs, fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.version.txt`), `${version.stdout}${version.stderr}`)
  const text = `${version.stdout}\n${version.stderr}`
  const match = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/)
  return { help, version, value: version.code === 0 ? match?.[0] ?? null : null }
}

export function redact(value, allowed, fixtureRoot) {
  const answer = String(value)
  const sensitive = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Jane Doe|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/|[A-Z]:\\Users\\)/i
  if (sensitive.test(answer)) return ''
  return normalizeFixtureTokens(answer, allowed)
}

export function normalizeFixtureTokens(value, allowed) {
  const answer = String(value)
  const hits = allowed.filter((token) => token).map((token) => ({ token, index: answer.indexOf(token) }))
    .filter((hit) => hit.index >= 0).sort((a, b) => a.index - b.index)
  return [...new Set(hits.map((hit) => hit.token))].join('\n')
}

export function validateResult(result) {
  for (const key of ['agent', 'agentId', 'version', 'measured', 'interface', 'question']) {
    if (typeof result?.[key] !== 'string' || !result[key].trim()) throw new Error(`${key} is required`)
  }
  if (!result.facts || typeof result.facts !== 'object' || Array.isArray(result.facts)) throw new Error('facts must be an object')
  if (result.status !== 'asked' && result.status !== 'could-not-ask') throw new Error('status must be asked or could-not-ask')
  if (typeof result.rawAnswer !== 'string' || (result.status === 'asked' && !result.rawAnswer.trim())) throw new Error('rawAnswer is required for asked results')
  if (result.rawAnswer && result.rawAnswer.split('\n').some((line) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(line))) throw new Error('rawAnswer must contain normalized fixture tokens')
  if (result.status === 'could-not-ask' && result.rawAnswer !== '') throw new Error('could-not-ask results cannot persist an answer')
  if (/(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(JSON.stringify(result.facts))) throw new Error('sensitive facts are forbidden')
  if (result.status === 'could-not-ask' && (typeof result.reason !== 'string' || !result.reason.trim())) throw new Error('reason is required for could-not-ask')
  if (result.status === 'could-not-ask' && /(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(result.reason)) throw new Error('sensitive reason is forbidden')
  if (result.status === 'asked' && result.reason !== undefined) throw new Error('reason is only valid for could-not-ask')
  return result
}

export function registerProbe(agentId, probe) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function')
  PROBES.set(agentId, probe)
}

export async function askAgent(agent, fixture) {
  const base = { agent: agent.name, agentId: agent.id, version: agent.version ?? 'unknown', measured: new Date().toISOString().slice(0, 10), interface: 'not selected', question: 'Probe the agent through its own interface', rawAnswer: '', facts: {}, fixtureRoot: fixture.root }
  if (!fixture.isolation.available) return validateResult({ ...base, status: 'could-not-ask', reason: 'cannot isolate' })
  const probe = PROBES.get(agent.id)
  if (!probe) return validateResult({ ...base, status: 'could-not-ask', reason: `no safe probe registered for ${agent.id}` })
  try {
    const answer = await probe(agent, fixture)
    if (answer.status === 'could-not-ask') {
      const reason = typeof answer.reason === 'string' && !/(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(answer.reason)
        ? answer.reason : 'probe declined safely'
      return validateResult({ ...base, interface: answer.interface ?? base.interface, question: answer.question ?? base.question, status: 'could-not-ask', reason })
    }
    const normalizedRaw = redact(answer.rawAnswer ?? '', answer.allowedRawTokens ?? [], fixture.root)
    if (!normalizedRaw) return validateResult({ ...base, status: 'could-not-ask', reason: 'answer failed the fixture-only privacy allowlist' })
    const facts = answer.facts ?? {}
    if (/(?:Jane Doe|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\/Users\/)/i.test(JSON.stringify(facts))) {
      return validateResult({ ...base, status: 'could-not-ask', reason: 'parsed facts failed the privacy allowlist' })
    }
    return validateResult({
      ...base,
      interface: answer.interface ?? base.interface,
      question: answer.question ?? base.question,
      rawAnswer: normalizedRaw,
      facts,
      status: answer.status ?? 'asked',
    })
  } catch (error) {
    return validateResult({ ...base, status: 'could-not-ask', reason: `probe failed safely (${error instanceof Error ? error.name : 'unknown error'})` })
  }
}

export async function writeResult(result, directory = RESULT_DIR_PATH) {
  const { fixtureRoot = '', ...publicResult } = result
  const safe = validateResult(publicResult)
  const agentSlug = String(safe.agentId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const versionSlug = String(safe.version).replace(/[^A-Za-z0-9.+_-]/g, '-')
  const path = join(directory, `${agentSlug}-${versionSlug}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  return path
}

export async function findAgentInstall(agent, fixture) {
  const { candidatePaths, findInstalls, judgeInstalls } = await import('../../packages/server/dist/src/installs/locate.js')
  const spec = agent.id === 'codex'
    ? { commands: ['codex'], versionArgs: ['--version'] }
    : agent.cli
  const locateOptions = { home: homedir(), env: { PATH: process.env.PATH ?? '' } }
  const candidates = candidatePaths(spec, locateOptions).filter(existsSync)
  const protectedRoots = REAL_HOME_BLOCKS.map((path) => join(homedir(), path))
    .concat(['/Library/Keychains', '/System/Library/Keychains'])
  const candidateNeedsDeniedAccess = candidates.some((path) => {
    let real = path
    try { real = realpathSync(path) } catch {}
    return protectedRoots.some((root) => isWithin(root, path) || isWithin(root, real))
  })
  if (candidateNeedsDeniedAccess) return { chosen: null, cannotIsolate: true }
  const found = await findInstalls(spec, {
    ...locateOptions,
    probe: async (path, args) => {
      try {
        const result = await run(path, [...args], fixture, { timeoutMs: 10_000 })
        return result.code === 0 ? `${result.stdout}\n${result.stderr}` : null
      } catch {
        return null
      }
    },
  })
  return { chosen: judgeInstalls(found, { minVersion: spec.minVersion }).chosen, cannotIsolate: false }
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--all')) throw new Error('usage: node script/measure/library.mjs --all')
  await import('./probes/index.mjs')
  const { KNOWN_AGENTS } = await import('../../packages/server/dist/src/installs/known-agents.js')
  const agents = [{ id: 'codex', name: 'Codex' }, ...KNOWN_AGENTS]
  for (const agent of agents) {
    const root = await mkdtemp('/tmp/hd-measure-')
    try {
      const fixture = await createFixture(root)
      if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
        fixture.isolation.available = false
        fixture.isolation.reason = 'cannot isolate: sandbox-exec unavailable'
      }
      const profilePath = join(root, 'probe.sb')
      if (fixture.isolation.available) {
        await writeFile(profilePath, makeSandboxProfile(root))
        fixture.isolation.available = verifySandbox(profilePath, root)
        if (!fixture.isolation.available) fixture.isolation.reason = 'cannot isolate: sandbox profile preflight failed'
      }
      const installResult = fixture.isolation.available ? await findAgentInstall(agent, fixture) : { chosen: null, cannotIsolate: true }
      const install = installResult.chosen
      const command = install?.path
      const discovered = command
        ? await captureHelpVersion({ ...agent, command }, fixture)
        : null
      const result = command && discovered?.value && discovered.value === install.version
        ? await askAgent({ ...agent, command, version: discovered.value }, fixture)
        : validateResult({
            agent: agent.name, agentId: agent.id, version: 'unknown', measured: new Date().toISOString().slice(0, 10),
            interface: 'not launched', question: 'Is an installed build available?', rawAnswer: '', facts: {},
            status: 'could-not-ask',
            reason: !fixture.isolation.available || installResult.cannotIsolate ? 'cannot isolate' : !install ? 'binary not installed' : !discovered?.value ? 'could not capture an exact version' : 'installed version changed during discovery',
          })
      await writeResult(result)
      process.stdout.write(`${result.status}: ${agent.id} ${result.version}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main()
