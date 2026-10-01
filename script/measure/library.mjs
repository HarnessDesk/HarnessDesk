import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
const VERIFIED_FIXTURES = new WeakMap()
const KNOWN_AGENTS_SOURCE = new URL('../../packages/server/src/installs/known-agents.ts', import.meta.url)
const KNOWN_SKILL_ROOTS = {
  claudecode: { user: ['~/.claude/skills'], project: ['.claude/skills'] },
  cursor: { user: ['~/.cursor/skills', '~/.cursor/skills-cursor'], project: ['.cursor/skills'] },
  geminicli: { user: ['~/.gemini/skills'], project: ['.gemini/skills'] },
  deepseek: { user: ['~/.dsh/skills'], project: ['.dsh/skills'] },
}
const CREDENTIAL_ROOTS = [
  '.harnessdesk', '.codex', '.claude.json', '.agents', '.local/share', '.config', '.ssh', '.aws',
  '.azure', '.kube', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki',
  '.git-credentials', 'Library/Keychains', 'Library/Application Support',
]
const FACT_KEYS = new Set(['rulesFiles', 'catalogue', 'precedence', 'rejections', 'skillRoots', 'refresh', 'mcp', 'signedOutCatalogue'])
const unmeasuredFacts = () => Object.fromEntries([...FACT_KEYS].map((key) => [key, { status: 'could-not-ask' }]))
const SAFE_FACT_STRINGS = new Set([
  'user', 'project', 'unknown', 'asked', 'could-not-ask', 'none', 'live', 'restart', 'available', 'empty',
  'connected', 'disconnected', 'accepted', 'rejected', 'enabled', 'disabled', 'loaded', 'not-loaded',
  'true', 'false', 'fixture', 'read', 'not-read', 'reported', 'not-reported', 'visible', 'not-visible',
])
const SAFE_TEXT_WORDS = new Set([
  'a', 'an', 'and', 'agent', 'available', 'app-server', 'are', 'as', 'build', 'catalogue', 'codex',
  'could', 'cursor', 'deepseek', 'denied', 'does', 'doesnt', 'empty', 'for', 'fixture', 'from', 'gemini',
  'harness', 'if', 'in', 'installed', 'interface', 'is', 'it', 'loaded', 'mcp', 'measurement', 'not',
  'of', 'or', 'probe', 'project', 'read', 'refresh', 'rules', 'safe', 'sentinel', 'signed', 'skill',
  'skills', 'status', 'the', 'through', 'to', 'user', 'visible', 'which', 'while', 'with', 'unknown',
  'supports', 'reports', 'rejections', 'precedence', 'roots', 'limits', 'question', 'server', 'launch',
  'selected', 'launched', 'own', 'available', 'and', 'not', 'registered', 'unregistered', 'binary', 'isolated', 'isolate', 'test',
  'failed', 'safely', 'privacy', 'allowlist', 'parsed', 'facts', 'answer', 'needs', 'sign-in', 'measured', 'is',
  'exact', 'version', 'changed', 'during', 'discovery', 'couldnt', 'capture', 'an', 'installed', 'available', 'its', 'list',
  'openai', 'claude', 'opencode', 'cline', 'hermes', 'codebuddy', 'kimi', 'pi', 'grok', 'copilot', 'antigravity', 'devin',
  'model', 'required', 'unavailable', 'listing', 'session', 'acp', 'out', 'initialize', 'request', 'cannot', 'isolation',
])

const write = async (path, body) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

const skillBody = (name, description, extra = '') =>
  `---\nname: ${name}\n${description === null ? '' : `description: ${description}\n`}---\n\n${extra || `Fixture for ${name}.`}\n`

export function knownAgentHomeEntries(source = readFileSync(KNOWN_AGENTS_SOURCE, 'utf8')) {
  return [...source.matchAll(/\bhome:\s*\{([\s\S]*?)^\s{4}\},/gm)].flatMap((match) => {
    const path = match[1].match(/^\s*path:\s*['"]([^'"]+)['"]/m)?.[1]
    if (!path) return []
    const env = match[1].match(/^\s*env:\s*['"]([^'"]+)['"]/m)?.[1]
    return [{ path, ...(env ? { env } : {}) }]
  })
}

function knownAgentWords() {
  const source = readFileSync(KNOWN_AGENTS_SOURCE, 'utf8')
  return new Set([...source.matchAll(/^\s*name:\s*['"]([^'"]+)['"]/gm)]
    .flatMap((match) => match[1].toLowerCase().split(/[^a-z0-9+-]+/).filter(Boolean)))
}

function knownAgentIds() {
  return new Set(['codex', ...readFileSync(KNOWN_AGENTS_SOURCE, 'utf8').matchAll(/^\s{4}id:\s*['"]([^'"]+)['"]/gm)].map((entry) => Array.isArray(entry) ? entry[1] : entry))
}

function knownAgentNames() {
  return new Set(['Codex', 'Test Agent', ...readFileSync(KNOWN_AGENTS_SOURCE, 'utf8').matchAll(/^\s{4}name:\s*['"]([^'"]+)['"]/gm)].map((entry) => Array.isArray(entry) ? entry[1] : entry))
}

export function deniedHomePaths(realHome = homedir()) {
  const expand = (path) => path.startsWith('~/') ? join(realHome, path.slice(2)) : path
  return [...new Set([
    ...knownAgentHomeEntries().map(({ path }) => expand(path)),
    ...CREDENTIAL_ROOTS.map((path) => join(realHome, path)),
    '/Library/Keychains',
    '/System/Library/Keychains',
  ])]
}

const fixtureTokens = (fixture) => [...new Set([
  ...Object.values(fixture.ruleSentinels),
  ...Object.values(fixture.skills).map((path) => basename(path)),
  'measure-with-auxiliary', 'AUXILIARY_FILE_SENTINEL', 'USER_COPY_SENTINEL', 'PROJECT_COPY_SENTINEL',
])]

const sensitiveString = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:sk|gh[pousr]?|xox[baprs])-[-A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{16,}|Jane Doe|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var|Library|System)\/|(?:^|\s)~\/|[A-Z]:\\Users\\)/i

function safeText(value, fixture) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || sensitiveString.test(value)) return false
  const fixtureWords = new Set(fixtureTokens(fixture).flatMap((token) => token.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)))
  const fixedWords = knownAgentWords()
  return [...value.toLowerCase().matchAll(/[a-z][a-z0-9+-]*/g)].every(([word]) => SAFE_TEXT_WORDS.has(word) || fixtureWords.has(word) || fixedWords.has(word))
}

function safeFact(value, fixture, depth = 0) {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true
  if (typeof value === 'string') return fixtureTokens(fixture).includes(value) || SAFE_FACT_STRINGS.has(value)
  if (Array.isArray(value)) return value.length <= 500 && value.every((item) => safeFact(item, fixture, depth + 1))
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).length <= 500 && Object.entries(value).every(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && !/(?:account|token|secret|email|path|credential|password|cookie|auth)/i.test(key) && safeFact(item, fixture, depth + 1))
  }
  return false
}

export async function createFixture(root) {
  root ??= await mkdtemp('/tmp/hd-measure-')
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const nested = join(repo, 'nested')
  const fixture = {
    root, home, repo, nested,
    harnessHome: join(home, 'harnessdesk'),
    isolation: {
      available: false,
      preflightPassed: false,
      reason: 'preflight required',
      profilePath: join(root, 'probe.sb'),
      profileText: null,
    },
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
  mkdirSync(canaryHome, { recursive: true })
  const canonicalCanaryHome = realpathSync(canaryHome)
  const canaryProfilePath = join(fixtureRoot, 'canary-profile.sb')
  const controlPath = join(fixtureRoot, 'control.sb')
  const controlFile = join(canonicalCanaryHome, 'control-canary')
  const profile = makeSandboxProfile(fixtureRoot)
  if (!profile || readFileSync(profilePath, 'utf8') !== profile) return false
  const realHome = realpathSync(homedir())
  const canaryProfile = sandboxProfileText(canonicalCanaryHome)
  if (profile.split(realHome).join(canonicalCanaryHome) !== canaryProfile) return false
  writeFileSync(canaryProfilePath, canaryProfile)

  const canaryRoots = [...new Set(deniedHomePaths(canonicalCanaryHome)
    .filter((path) => isWithin(canonicalCanaryHome, path)))]
  if (!canaryRoots.length) return false
  const canaryPaths = canaryRoots.map((path, index) => join(path, `canary-${index}`))
  for (const path of canaryPaths) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'sandbox denial canary')
  }
  writeFileSync(controlFile, 'sandbox control canary')
  const runCanary = (script, path) => spawnSync('/usr/bin/sandbox-exec', [
    '-f', canaryProfilePath, process.execPath, '-e', script, path,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 })
  const succeeded = (result) => Boolean(result && !result.error && !result.signal && result.status === 0)
  const denyScript = `
    const fs = require('node:fs');
    const path = process.argv[1];
    let readDenied = false, writeDenied = false;
    try { fs.readFileSync(path); } catch (error) { readDenied = ['EPERM', 'EACCES'].includes(error.code); }
    try { fs.writeFileSync(path, 'must be denied'); } catch (error) { writeDenied = ['EPERM', 'EACCES'].includes(error.code); }
    if (!readDenied || !writeDenied) process.exit(31);
  `
  for (const path of canaryPaths) if (!succeeded(runCanary(denyScript, path))) return false
  const readableControl = runCanary(
    `const fs = require('node:fs'); if (fs.readFileSync(process.argv[1], 'utf8') !== 'sandbox control canary') process.exit(32);`,
    controlFile,
  )
  if (!succeeded(readableControl)) return false

  const service = `harnessdesk-measure-canary-${process.pid}`
  const keychain = join(fixtureRoot, 'canary.keychain-db')
  const keychainPassword = randomBytes(32).toString('base64url')
  const itemPassword = randomBytes(32).toString('base64url')
  // The control profile is the real one minus its securityd denials. The same
  // lookup must succeed under the control and fail under the real profile:
  // that difference pins the refusal on the deny rule, not on the sandbox
  // environment, the keychain path, or an "item not found" for any other reason.
  writeFileSync(controlPath, readFileSync(profilePath, 'utf8').split('\n').filter((line) => !/mach-lookup/.test(line)).join('\n'))
  const security = (args, profile = null) => spawnSync(
    profile ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
    profile ? ['-f', profile, '/usr/bin/security', ...args] : args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
  )
  let passed = false
  try {
    const created = security(['create-keychain', '-p', keychainPassword, keychain])
    if (!succeeded(created)) return false
    const unlocked = security(['unlock-keychain', '-p', keychainPassword, keychain])
    if (!succeeded(unlocked)) return false
    const added = security(['add-generic-password', '-s', service, '-a', 'canary', '-w', itemPassword, keychain])
    if (!succeeded(added)) return false
    const outside = security(['find-generic-password', '-s', service, keychain])
    if (!succeeded(outside)) return false
    const control = security(['find-generic-password', '-s', service, keychain], controlPath)
    if (!succeeded(control)) return false
    const inside = security(['find-generic-password', '-s', service, keychain], profilePath)
    const deniedBySandbox = Boolean(inside) && !inside.error && !inside.signal && inside.status !== 0
    passed = deniedBySandbox
  } finally {
    if (existsSync(keychain)) {
      const deleted = security(['delete-keychain', keychain])
      if (!succeeded(deleted)) passed = false
    }
  }
  return passed
}

export function sandboxProfileText(realHome, extraDeniedRoots = []) {
  const blocked = [...deniedHomePaths(realHome), ...extraDeniedRoots]
  const denies = blocked.map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join('\n')
  return `(version 1)\n(allow default)\n${denies}\n(deny mach-lookup (global-name "com.apple.securityd"))\n(deny mach-lookup (global-name "com.apple.SecurityServer"))\n`
}

export function normalizeVersion(value) {
  return typeof value === 'string' && value.length <= 40 && /^\d+(\.\d+){0,3}(-[0-9A-Za-z.]{1,24})?$/.test(value)
    ? value
    : 'unknown'
}

export async function prepareSandbox(fixture) {
  fixture.isolation.preflightPassed = false
  fixture.isolation.available = false
  VERIFIED_FIXTURES.delete(fixture)
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    fixture.isolation.reason = 'cannot isolate: macOS sandbox-exec unavailable'
    return false
  }
  const profile = makeSandboxProfile(fixture.root)
  if (!profile) {
    fixture.isolation.reason = 'cannot isolate: sandbox profile unavailable'
    return false
  }
  await writeFile(fixture.isolation.profilePath, profile, 'utf8')
  fixture.isolation.profileText = profile
  fixture.isolation.preflightPassed = verifySandbox(fixture.isolation.profilePath, fixture.root)
  fixture.isolation.available = fixture.isolation.preflightPassed
  fixture.isolation.reason = fixture.isolation.preflightPassed ? '' : 'cannot isolate: sandbox profile preflight failed'
  if (fixture.isolation.preflightPassed) VERIFIED_FIXTURES.set(fixture, profile)
  return fixture.isolation.preflightPassed
}

export function agentHomeIsIsolated(agent, fixture) {
  if (!fixture.isolation.preflightPassed || VERIFIED_FIXTURES.get(fixture) !== fixture.isolation.profileText) return false
  const declared = agent.id === 'codex' ? { path: '~/.codex' } : agent.home
  if (!declared?.path) return false
  const realHome = realpathSync(homedir())
  const home = declared.path.startsWith('~/') ? join(realHome, declared.path.slice(2)) : resolve(realHome, declared.path)
  const homeDenied = fixture.isolation.profileText.includes(`(subpath ${JSON.stringify(home)})`)
  if (!homeDenied) return false
  if (!declared.env) return true
  if (!VENDOR_HOMES.includes(declared.env)) return false
  const override = safeEnv(fixture)[declared.env]
  return Boolean(override && isWithin(fixture.root, override))
}

export function run(command, args, fixture, { cwd = fixture.repo, timeoutMs = 60_000, input = '', envOverrides = {}, allowedEnv = [] } = {}) {
  if (!fixture.isolation.preflightPassed || !fixture.isolation.profileText || VERIFIED_FIXTURES.get(fixture) !== fixture.isolation.profileText) throw new Error('cannot isolate: sandbox preflight has not passed in this process')
  if (Object.keys(envOverrides).some((name) => !allowedEnv.includes(name))) throw new Error('subprocess environment override is not allowlisted')
  const env = { ...safeEnv(fixture), ...envOverrides, cwd }
  assertIsolatedEnv(env, fixture.root)
  const profilePath = fixture.isolation.profilePath
  if (readFileSync(profilePath, 'utf8') !== fixture.isolation.profileText || makeSandboxProfile(fixture.root) !== fixture.isolation.profileText) throw new Error('cannot isolate: verified sandbox profile changed')
  const sandboxEnv = { ...env, cwd: fixture.repo }
  return new Promise((resolveRun, rejectRun) => {
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
  })
}

export async function captureHelpVersion(agent, fixture) {
  const help = await run(agent.command, ['--help'], fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.help.txt`), `${help.stdout}${help.stderr}`)
  const versionArgs = agent.cli?.versionArgs ?? ['--version']
  const version = await run(agent.command, versionArgs, fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.version.txt`), `${version.stdout}${version.stderr}`)
  const text = `${version.stdout}\n${version.stderr}`
  const match = text.match(/\b\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.]{1,24})?(?:\+[0-9A-Za-z.-]+)?/)
  return { help, version, value: normalizeVersion(version.code === 0 ? match?.[0] : null) }
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

export function validateResult(result, fixture) {
  if (!fixture || !Array.isArray(fixtureTokens(fixture))) throw new Error('fixture-derived result allowlist is required')
  const allowedKeys = new Set(['agent', 'agentId', 'version', 'measured', 'interface', 'question', 'rawAnswer', 'facts', 'status', 'reason'])
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some((key) => !allowedKeys.has(key))) throw new Error('result has fields outside the strict schema')
  for (const key of ['agent', 'agentId', 'version', 'measured', 'interface', 'question']) {
    if (typeof result[key] !== 'string' || !result[key].trim()) throw new Error(`${key} is required`)
  }
  if (!knownAgentNames().has(result.agent) || !knownAgentIds().has(result.agentId)) throw new Error('agent identity is not allowlisted')
  if (result.version !== 'unknown' && (result.version.length > 40 || !/^\d+(\.\d+){0,3}(-[0-9A-Za-z.]{1,24})?$/.test(result.version))) throw new Error('version is not allowlisted')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.measured)) throw new Error('measured must be a date')
  for (const key of ['interface', 'question']) if (!safeText(result[key], fixture)) throw new Error(`${key} is outside the fixture-derived allowlist`)
  if (!result.facts || typeof result.facts !== 'object' || Array.isArray(result.facts)) throw new Error('facts must be an object')
  if (Object.keys(result.facts).some((key) => !FACT_KEYS.has(key)) || !safeFact(result.facts, fixture)) throw new Error('facts are outside the fixture-derived allowlist')
  if (result.status !== 'asked' && result.status !== 'could-not-ask') throw new Error('status must be asked or could-not-ask')
  const signedOutStatus = result.facts?.signedOutCatalogue?.status ?? result.facts?.signedOutCatalogue
  if (typeof result.rawAnswer !== 'string' || (result.status === 'asked' && !result.rawAnswer.trim() && !['available', 'empty'].includes(signedOutStatus))) throw new Error('rawAnswer is required for asked results')
  if (result.rawAnswer && result.rawAnswer.split('\n').some((line) => !fixtureTokens(fixture).includes(line))) throw new Error('rawAnswer must contain only fixture-derived tokens')
  if (result.status === 'could-not-ask' && result.rawAnswer !== '') throw new Error('could-not-ask results cannot persist an answer')
  if (result.status === 'could-not-ask' && (typeof result.reason !== 'string' || !safeText(result.reason, fixture))) throw new Error('reason is outside the fixture-derived allowlist')
  if (result.status === 'asked' && result.reason !== undefined) throw new Error('reason is only valid for could-not-ask')
  return result
}

export function registerProbe(agentId, probe) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function')
  PROBES.set(agentId, probe)
}

export async function askAgent(agent, fixture) {
  const base = { agent: agent.name, agentId: agent.id, version: agent.version ?? 'unknown', measured: new Date().toISOString().slice(0, 10), interface: 'not selected', question: 'Probe the agent through its own interface', rawAnswer: '', facts: {}, fixtureRoot: fixture.root }
  if (!fixture.isolation.preflightPassed || !agentHomeIsIsolated(agent, fixture)) return { ...base, status: 'could-not-ask', reason: 'cannot isolate' }
  const probe = PROBES.get(agent.id)
  if (!probe) return { ...base, status: 'could-not-ask', reason: 'no safe probe registered' }
  try {
    const answer = await probe(agent, fixture)
    if (answer.status === 'could-not-ask') {
      const reason = typeof answer.reason === 'string' && safeText(answer.reason, fixture) ? answer.reason : 'probe failed safely'
      const facts = answer.facts && Object.keys(answer.facts).every((key) => FACT_KEYS.has(key)) && safeFact(answer.facts, fixture) ? answer.facts : {}
      return { ...base, interface: safeText(answer.interface, fixture) ? answer.interface : base.interface, question: safeText(answer.question, fixture) ? answer.question : base.question, facts, status: 'could-not-ask', reason }
    }
    const normalizedRaw = redact(answer.rawAnswer ?? '', fixtureTokens(fixture), fixture.root)
    const signedOutStatus = answer.facts?.signedOutCatalogue?.status ?? answer.facts?.signedOutCatalogue
    const observedListing = ['available', 'empty'].includes(signedOutStatus)
    if (!normalizedRaw && !observedListing) return { ...base, status: 'could-not-ask', reason: 'answer failed the fixture-only privacy allowlist' }
    const facts = answer.facts ?? {}
    if (!safeFact(facts, fixture) || Object.keys(facts).some((key) => !FACT_KEYS.has(key))) return { ...base, status: 'could-not-ask', reason: 'parsed facts failed the privacy allowlist' }
    if (!safeText(answer.interface ?? base.interface, fixture)) return { ...base, status: 'could-not-ask', reason: 'probe interface failed the privacy allowlist' }
    if (!safeText(answer.question ?? base.question, fixture)) return { ...base, status: 'could-not-ask', reason: 'probe question failed the privacy allowlist' }
    const result = {
      ...base,
      interface: safeText(answer.interface ?? base.interface, fixture) ? answer.interface ?? base.interface : base.interface,
      question: safeText(answer.question ?? base.question, fixture) ? answer.question ?? base.question : base.question,
      rawAnswer: normalizedRaw,
      facts,
      status: answer.status ?? 'asked',
    }
    try {
      const { fixtureRoot: _fixtureRoot, ...publicResult } = result
      return validateResult(publicResult, fixture)
    } catch {
      return { ...base, status: 'could-not-ask', reason: 'probe result failed the privacy allowlist' }
    }
  } catch {
    return { ...base, status: 'could-not-ask', reason: 'probe failed safely' }
  }
}

export async function writeResult(result, directory = RESULT_DIR_PATH, fixture) {
  const { fixtureRoot = '', ...publicResult } = result
  const safe = validateResult(publicResult, fixture)
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
  if (!agentHomeIsIsolated(agent, fixture)) return { chosen: null, cannotIsolate: true }
  const protectedRoots = deniedHomePaths(realpathSync(homedir()))
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
  const probes = await import('./probes/index.mjs')
  probes.installProbes({ run, registerProbe })
  const { KNOWN_AGENTS } = await import('../../packages/server/dist/src/installs/known-agents.js')
  const agents = [{ id: 'codex', name: 'Codex' }, ...KNOWN_AGENTS]
  for (const agent of agents) {
    const root = await mkdtemp('/tmp/hd-measure-')
    try {
      const fixture = await createFixture(root)
      await prepareSandbox(fixture)
      const homeSafe = fixture.isolation.preflightPassed && agentHomeIsIsolated(agent, fixture)
      const installResult = homeSafe ? await findAgentInstall(agent, fixture) : { chosen: null, cannotIsolate: true }
      const install = installResult.chosen
      const command = install?.path
      const discovered = command
        ? await captureHelpVersion({ ...agent, command }, fixture)
        : null
      const result = command && discovered?.value && discovered.value === install.version
        ? await askAgent({ ...agent, command, version: discovered.value }, fixture)
        : {
            agent: agent.name, agentId: agent.id, version: 'unknown', measured: new Date().toISOString().slice(0, 10),
            interface: 'not launched', question: 'Is an installed build available?', rawAnswer: '', facts: unmeasuredFacts(),
            status: 'could-not-ask',
            reason: !fixture.isolation.available || installResult.cannotIsolate ? 'cannot isolate' : !install ? 'binary not installed' : !discovered?.value ? 'could not capture an exact version' : 'installed version changed during discovery',
          }
      await writeResult(result, RESULT_DIR_PATH, fixture)
      process.stdout.write(`${result.status}: ${agent.id} ${result.version}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main()
