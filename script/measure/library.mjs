import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
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
export const KEYCHAIN_READ_ONLY = 'keychain-read-only'
// This exception differs from strict only by allowing keychain reads and omitting the two keychain Mach denials; both profiles retain the keychain write denial, and (allow default) is required for Node and system frameworks to start.
const KEYCHAIN_READ_ONLY_AGENTS = new Set(['claude-code', 'cursor', 'grok-build'])
const FACT_KEYS = new Set(['rulesFiles', 'catalogue', 'reportsCatalogue', 'precedence', 'rejections', 'reportsRejections', 'skillRoots', 'refresh', 'mcp', 'signedOutCatalogue'])
const unmeasuredFacts = () => ({
  rulesFiles: { status: 'could-not-ask' }, catalogue: { status: 'could-not-ask' }, reportsCatalogue: false,
  precedence: { status: 'could-not-ask' }, rejections: { status: 'could-not-ask' }, reportsRejections: false,
  skillRoots: [],
  refresh: { status: 'could-not-ask', catalogueRefresh: 'none', skillToggle: false, openSessionSeesChange: 'unknown' },
  mcp: { status: 'could-not-ask' }, signedOutCatalogue: { status: 'unknown' },
})
const SAFE_FACT_STRINGS = new Set([
  'user', 'project', 'unknown', 'asked', 'could-not-ask', 'none', 'live', 'restart', 'available', 'empty',
  'connected', 'disconnected', 'accepted', 'rejected', 'enabled', 'disabled', 'loaded', 'not-loaded',
  'true', 'false', 'fixture', 'read', 'not-read', 'reported', 'not-reported', 'visible', 'not-visible',
  'no-session', 'session-created',
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
  'candidate', 'unreadable', 'no', 'while',
  'created',
  'below', 'supported', 'floor',
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

const safeRelativeFactPath = (value) => typeof value === 'string'
  && /^(?:~\/|\.\/|\.[A-Za-z0-9_-]+\/)[A-Za-z0-9_./-]+$/.test(value)
  && !value.split('/').includes('..')

function safeFact(value, fixture, depth = 0) {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true
  if (typeof value === 'string') return fixtureTokens(fixture).includes(value) || SAFE_FACT_STRINGS.has(value) || safeRelativeFactPath(value)
  if (Array.isArray(value)) return value.length <= 500 && value.every((item) => safeFact(item, fixture, depth + 1))
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).length <= 500 && Object.entries(value).every(([key, item]) => {
      const safePath = key === 'path' && safeRelativeFactPath(item)
      return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && (safePath || !/(?:account|token|secret|email|path|credential|password|cookie|auth)/i.test(key)) && (safePath || safeFact(item, fixture, depth + 1))
    })
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

export function nodeInstallPrefix(binary = process.execPath) {
  const realBinary = realpathSync(binary)
  return dirname(dirname(realBinary))
}

export function makeSandboxProfile(root, realHome = homedir(), options = {}) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null
  const canonicalFixtureRoot = realpathSync(root)
  return sandboxProfileText(realpathSync(realHome), {
    fixtureRoot: canonicalFixtureRoot,
    fixtureRoots: [...new Set([resolve(root), canonicalFixtureRoot])],
    readPaths: [nodeInstallPrefix(), ...(options.readPaths ?? [])], isolation: options.isolation ?? 'strict',
  })
}

export function verifySandbox(profilePath, fixtureRoot, { isolation = 'strict', readPaths = [] } = {}) {
  const fixtureAlias = resolve(fixtureRoot)
  const canonicalFixtureRoot = realpathSync(fixtureRoot)
  fixtureRoot = canonicalFixtureRoot
  const outsideRoot = mkdtempSync('/tmp/hd-measure-outside-')
  const canaryHome = join(outsideRoot, 'sandbox-canary-home')
  mkdirSync(canaryHome, { recursive: true })
  const canonicalCanaryHome = realpathSync(canaryHome)
  const canaryProfilePath = join(fixtureRoot, `canary-${isolation}.sb`)
  const controlPath = join(fixtureRoot, `control-${isolation}.sb`)
  const unrelated = join(canonicalCanaryHome, 'unrelated-canary.txt')
  const insideWrite = join(fixtureRoot, 'tmp', 'write-canary.txt')
  const insideAliasWrite = join(fixtureAlias, 'tmp', 'alias-write-canary.txt')
  const outsideWrite = join(outsideRoot, 'write-canary.txt')
  const siblingCredential = join(outsideRoot, 'sibling-credentials', 'credential-canary.txt')
  const runtimeCanaryAlias = join(outsideRoot, 'agent-runtime-canary')
  const keychainCanary = join(canonicalCanaryHome, 'Library/Keychains/read-canary')
  const credentialInRuntime = join(runtimeCanaryAlias, 'credential-canary', 'secret.txt')
  const fixtureRead = join(fixtureRoot, 'tmp', 'read-canary.txt')
  mkdirSync(dirname(keychainCanary), { recursive: true })
  mkdirSync(dirname(siblingCredential), { recursive: true })
  mkdirSync(runtimeCanaryAlias, { recursive: true })
  const runtimeCanaryRoot = realpathSync(runtimeCanaryAlias)
  const runtimeCanary = join(runtimeCanaryRoot, 'runtime-canary.txt')
  mkdirSync(dirname(credentialInRuntime), { recursive: true })
  mkdirSync(dirname(fixtureRead), { recursive: true })
  writeFileSync(unrelated, 'synthetic home canary')
  writeFileSync(siblingCredential, 'synthetic sibling credential canary')
  writeFileSync(runtimeCanary, 'synthetic runtime canary')
  writeFileSync(credentialInRuntime, 'synthetic runtime credential canary')
  writeFileSync(fixtureRead, 'synthetic fixture read canary')
  writeFileSync(keychainCanary, 'synthetic keychain canary')
  const profile = readFileSync(profilePath, 'utf8')
  const canaryProfile = sandboxProfileText(canonicalCanaryHome, {
    fixtureRoot,
    fixtureRoots: [...new Set([fixtureAlias, fixtureRoot])],
    readPaths: [nodeInstallPrefix(), runtimeCanaryRoot],
    additionalDeniedPaths: [canonicalCanaryHome, dirname(siblingCredential), realpathSync(dirname(siblingCredential)), join(runtimeCanaryRoot, 'credential-canary')],
    isolation,
  })
  const hostProfile = makeSandboxProfile(fixtureAlias, homedir(), { isolation, readPaths })
  if (!hostProfile || profile !== hostProfile) { rmSync(outsideRoot, { recursive: true, force: true }); return false }
  const realHome = realpathSync(homedir())
  const expectedProfile = sandboxProfileText(realHome, { fixtureRoot, fixtureRoots: [...new Set([fixtureAlias, fixtureRoot])], readPaths: [nodeInstallPrefix(), ...readPaths], isolation })
  if (profile !== expectedProfile) { rmSync(outsideRoot, { recursive: true, force: true }); return false }
  writeFileSync(canaryProfilePath, canaryProfile)
  const runCanary = (script, path) => spawnSync('/usr/bin/sandbox-exec', [
    '-f', canaryProfilePath, process.execPath, '-e', script, path,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 })
  const runUnderProfile = (profilePath, script, path) => spawnSync('/usr/bin/sandbox-exec', [
    '-f', profilePath, process.execPath, '-e', script, path,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 })
  const succeeded = (result) => Boolean(result && !result.error && !result.signal && result.status === 0)
  const sharedName = `harnessdesk-measure-${randomBytes(12).toString('hex')}`
  const usersShared = join('/', 'Users', 'Shared')
  const sharedReadCanary = join(usersShared, `${sharedName}-read`)
  const sharedWriteCanary = join(usersShared, `${sharedName}-write`)
  let sharedFileCreated = false
  let sharedReadPath = usersShared
  try {
    try {
      writeFileSync(sharedReadCanary, 'temporary sandbox canary')
      sharedFileCreated = true
      sharedReadPath = sharedReadCanary
    } catch {
      // A directory listing is the read probe when the canary file cannot be created.
    }
    const sharedReadScript = sharedFileCreated
      ? `const fs = require('node:fs'); try { fs.readFileSync(process.argv[1]); process.exit(51); } catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 52); }`
      : `const fs = require('node:fs'); try { fs.readdirSync(process.argv[1]); process.exit(51); } catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 52); }`
    const sharedDeniedRead = runUnderProfile(profilePath, sharedReadScript, sharedReadPath)
    const sharedDeniedWrite = runUnderProfile(profilePath, `const fs = require('node:fs'); try { fs.writeFileSync(process.argv[1], 'temporary sandbox canary'); process.exit(53); } catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 54); }`, sharedWriteCanary)
    const controlProfile = readFileSync(profilePath, 'utf8')
      .split('\n')
      .filter((line) => line !== `(deny file-read* file-write* (subpath ${JSON.stringify(join('/', 'Users'))}))`)
      .join('\n') + `\n(allow file-write* (literal ${JSON.stringify(sharedWriteCanary)}))\n`
    writeFileSync(controlPath, controlProfile)
    const controlReadScript = sharedFileCreated
      ? `require('node:fs').readFileSync(process.argv[1])`
      : `require('node:fs').readdirSync(process.argv[1])`
    const sharedControlRead = runUnderProfile(controlPath, controlReadScript, sharedReadPath)
    const sharedControlWrite = runUnderProfile(controlPath, `require('node:fs').writeFileSync(process.argv[1], 'temporary sandbox canary')`, sharedWriteCanary)
    if (![sharedDeniedRead, sharedDeniedWrite].every(succeeded) || ![sharedControlRead, sharedControlWrite].every(succeeded)) {
      console.error(`real /Users blanket denial differential: denied read exit=${sharedDeniedRead?.status} error=${sharedDeniedRead?.error?.code ?? ''}; denied write exit=${sharedDeniedWrite?.status} error=${sharedDeniedWrite?.error?.code ?? ''}; control read exit=${sharedControlRead?.status} error=${sharedControlRead?.error?.code ?? ''}; control write exit=${sharedControlWrite?.status} error=${sharedControlWrite?.error?.code ?? ''}`)
      rmSync(outsideRoot, { recursive: true, force: true })
      return false
    }
  } finally {
    if (sharedFileCreated) rmSync(sharedReadCanary, { force: true })
    rmSync(sharedWriteCanary, { force: true })
  }
  const deniedRead = runCanary(`
    const fs = require('node:fs');
    try { fs.readFileSync(process.argv[1]); process.exit(31); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(32); }
  `, unrelated)
  const deniedSiblingCredential = runCanary(`
    const fs = require('node:fs');
    try { fs.readFileSync(process.argv[1]); process.exit(40); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(41); }
  `, siblingCredential)
  const allowedRuntimeRead = runCanary(`require('node:fs').readFileSync(process.argv[1])`, runtimeCanary)
  const deniedRuntimeCredential = runCanary(`
    const fs = require('node:fs');
    try { fs.readFileSync(process.argv[1]); process.exit(42); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(43); }
  `, credentialInRuntime)
  const allowedFixtureRead = runCanary(`require('node:fs').readFileSync(process.argv[1])`, fixtureRead)
  const deniedWrite = runCanary(`
    const fs = require('node:fs');
    try { fs.writeFileSync(process.argv[1], 'must be denied'); process.exit(33); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(34); }
  `, outsideWrite)
  const allowedWrite = runCanary(`require('node:fs').writeFileSync(process.argv[1], 'fixture write allowed')`, insideWrite)
  const spawnedTrue = runCanary(`
    const { spawnSync } = require('node:child_process');
    const child = spawnSync('/usr/bin/true');
    if (child.error || child.status !== 0) process.exit(44);
  `, fixtureRead)
  const keychainRead = runCanary(`
    const fs = require('node:fs');
    try { fs.readFileSync(process.argv[1]); process.exit(${isolation === KEYCHAIN_READ_ONLY ? '0' : '35'}); } catch (error) { process.exit(${isolation === KEYCHAIN_READ_ONLY ? '36' : "['EPERM', 'EACCES'].includes(error.code) ? 0 : 37"}); }
  `, keychainCanary)
  const keychainWrite = runCanary(`
    const fs = require('node:fs');
    try { fs.writeFileSync(process.argv[1], 'must be denied'); process.exit(38); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(39); }
  `, keychainCanary)
  const allowedAliasWrite = runCanary(`require('node:fs').writeFileSync(process.argv[1], 'fixture alias write allowed')`, insideAliasWrite)
  const canaries = [
    ['file-read-data outside fixture', deniedRead], ['file-read-data sibling credential', deniedSiblingCredential],
    ['file-read-data allowed runtime', allowedRuntimeRead], ['file-read-data credential under runtime', deniedRuntimeCredential],
    ['file-read-data fixture', allowedFixtureRead], ['spawn /usr/bin/true', spawnedTrue],
    ['file-write outside fixture', deniedWrite], ['file-write canonical fixture', allowedWrite],
    ['file-write fixture alias', allowedAliasWrite], ['keychain read', keychainRead], ['keychain write denial', keychainWrite],
  ]
  if (!canaries.every(([, result]) => succeeded(result))) {
    console.error(canaries.filter(([, result]) => !succeeded(result)).map(([name, result]) => `${name}: exit=${result?.status} error=${result?.error?.message ?? ''} stderr=${result?.stderr ?? ''}`).join('\n'))
    rmSync(outsideRoot, { recursive: true, force: true }); return false
  }

  const service = `harnessdesk-measure-canary-${process.pid}`
  const keychain = join(fixtureRoot, 'canary.keychain-db')
  const keychainPassword = randomBytes(32).toString('base64url')
  const itemPassword = randomBytes(32).toString('base64url')
  // The control profile is the real one minus its securityd denials. The same
  // lookup must succeed under the control and fail under the real profile:
  // that difference pins the refusal on the deny rule, not on the sandbox
  // environment, the keychain path, or an "item not found" for any other reason.
  writeFileSync(controlPath, profile.split('\n').filter((line) => !/^\(deny mach-lookup/.test(line)).join('\n'))
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
    const keychainReadAllowed = isolation === KEYCHAIN_READ_ONLY
      ? succeeded(inside)
      : Boolean(inside) && !inside.error && !inside.signal && inside.status !== 0
    passed = keychainReadAllowed
  } finally {
    if (existsSync(keychain)) {
      const deleted = security(['delete-keychain', keychain])
      if (!succeeded(deleted)) passed = false
    }
    rmSync(outsideRoot, { recursive: true, force: true })
  }
  return passed
}

export function sandboxProfileText(realHome, { fixtureRoot = '/tmp/fixture', fixtureRoots = [], readPaths = [], additionalDeniedPaths = [], isolation = 'strict' } = {}) {
  if (isolation !== 'strict' && isolation !== KEYCHAIN_READ_ONLY) throw new Error('unknown isolation profile')
  const allowedFixtureRoots = [...new Set([fixtureRoot, ...fixtureRoots].map((path) => resolve(path)))]
  const allowedInstallRoots = [...new Set(readPaths.map((path) => resolve(path)))]
  const keychainRoot = resolve(join(realHome, 'Library/Keychains'))
  const deniedRoots = [...new Set([
    ...deniedHomePaths(realHome),
    ...additionalDeniedPaths.map((path) => resolve(path)),
  ])]
  const keychainRead = isolation === KEYCHAIN_READ_ONLY
    ? `(allow file-read* (subpath ${JSON.stringify(keychainRoot)}))\n`
    : ''
  const keychainServices = isolation === KEYCHAIN_READ_ONLY
    ? ''
    : `(deny mach-lookup (global-name "com.apple.securityd"))\n(deny mach-lookup (global-name "com.apple.SecurityServer"))\n`
  const fixtureWrites = allowedFixtureRoots.map((path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`).join('\n')
  const fixtureReads = allowedFixtureRoots.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`).join('\n')
  const installReads = allowedInstallRoots.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`).join('\n')
  const finalDenials = deniedRoots.map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join('\n')
  return `(version 1)\n(allow default)\n(deny file-read* file-write* (subpath "/Users"))\n(deny file-read* file-write* (subpath "/Volumes"))\n(deny file-write*)\n${fixtureWrites}\n(allow file-write* (literal "/dev/null"))\n(allow file-write* (regex #"^/dev/tty"))\n${fixtureReads}\n${installReads}\n${finalDenials}\n${keychainRead}${keychainServices}`
}

export function normalizeVersion(value) {
  return typeof value === 'string' && value.length <= 40 && /^\d+(\.\d+){0,3}(-[0-9A-Za-z.]{1,24})?$/.test(value)
    ? value
    : 'unknown'
}

export function installReadRoot(realPath) {
  const parts = resolve(realPath).split('/').filter(Boolean)
  const versions = parts.lastIndexOf('versions')
  if (versions >= 0 && parts[versions + 1]) return `/${parts.slice(0, versions + 2).join('/')}`
  const modules = parts.lastIndexOf('node_modules')
  if (modules >= 0 && parts[modules + 1]) return `/${parts.slice(0, modules + 1).join('/')}`
  const parent = dirname(realPath)
  return parent === realPath ? null : parent
}

export function installRootIsSafe(installRoot, realHome) {
  const root = resolve(installRoot)
  const components = root.split('/').filter(Boolean)
  const isWholeHomeOrVolume = (components[0] === 'Users' || components[0] === 'Volumes') && components.length === 2
  return !['/', '/Users', '/Volumes'].includes(root) && !isWholeHomeOrVolume && !isWithin(root, realHome)
}

export function installDiscoveryState({ candidateCount, copies = [], chosen = null, unsafeCount = 0 }) {
  if (chosen) return 'chosen'
  if (copies.some((copy) => copy.standing === 'unreadable' || copy.unreadable)) return 'unreadable'
  if (!candidateCount) return 'absent'
  if (unsafeCount) return 'unsafe'
  if (copies.some((copy) => copy.standing === 'too-old')) return 'below-floor'
  return 'unreadable'
}

export function shouldAskAgent(agent) {
  return !KEYCHAIN_READ_ONLY_AGENTS.has(agent.id)
}

export async function prepareSandbox(fixture, { isolation = 'strict', readPaths = [] } = {}) {
  fixture.isolation.preflightPassed = false
  fixture.isolation.available = false
  VERIFIED_FIXTURES.delete(fixture)
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    fixture.isolation.reason = 'cannot isolate: macOS sandbox-exec unavailable'
    return false
  }
  const profile = makeSandboxProfile(fixture.root, homedir(), { isolation, readPaths })
  if (!profile) {
    fixture.isolation.reason = 'cannot isolate: sandbox profile unavailable'
    return false
  }
  await writeFile(fixture.isolation.profilePath, profile, 'utf8')
  fixture.isolation.profileText = profile
  fixture.isolation.profile = isolation
  fixture.isolation.readPaths = readPaths
  fixture.isolation.preflightPassed = verifySandbox(fixture.isolation.profilePath, fixture.root, { isolation, readPaths })
  fixture.isolation.available = fixture.isolation.preflightPassed
  fixture.isolation.reason = fixture.isolation.preflightPassed ? '' : 'cannot isolate: sandbox profile preflight failed'
  if (fixture.isolation.preflightPassed) VERIFIED_FIXTURES.set(fixture, profile)
  return fixture.isolation.preflightPassed
}

export function agentHomeIsIsolated(agent, fixture) {
  if (!fixture.isolation.preflightPassed || VERIFIED_FIXTURES.get(fixture) !== fixture.isolation.profileText) return false
  const declared = agent.id === 'codex' ? { path: '~/.codex' } : agent.home
  if (!declared?.path) return false
  if (!fixture.isolation.profileText.includes('(allow default)')) return false
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
  if (readFileSync(profilePath, 'utf8') !== fixture.isolation.profileText || makeSandboxProfile(fixture.root, homedir(), { isolation: fixture.isolation.profile, readPaths: fixture.isolation.readPaths }) !== fixture.isolation.profileText) throw new Error('cannot isolate: verified sandbox profile changed')
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
  const allowedKeys = new Set(['agent', 'agentId', 'version', 'measured', 'interface', 'question', 'rawAnswer', 'facts', 'status', 'reason', 'isolation', 'auth'])
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
  if (result.isolation !== undefined && result.isolation !== KEYCHAIN_READ_ONLY) throw new Error('isolation is not allowlisted')
  if (result.auth !== undefined && result.auth !== 'owner subscription sign-in') throw new Error('auth is not allowlisted')
  if ((result.isolation === KEYCHAIN_READ_ONLY) !== (result.auth === 'owner subscription sign-in')) throw new Error('keychain exception results must carry isolation and auth together')
  const signedOutStatus = result.facts?.signedOutCatalogue?.status ?? result.facts?.signedOutCatalogue
  const observedSessionOutcome = ['no-session', 'session-created'].includes(result.facts?.signedOutCatalogue?.observation)
  if (typeof result.rawAnswer !== 'string' || (result.status === 'asked' && !result.rawAnswer.trim() && !['available', 'empty'].includes(signedOutStatus) && !observedSessionOutcome)) throw new Error('rawAnswer is required for asked results')
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
  const exception = fixture.isolation.profile === KEYCHAIN_READ_ONLY
  const base = { agent: agent.name, agentId: agent.id, version: agent.version ?? 'unknown', measured: new Date().toISOString().slice(0, 10), interface: 'not selected', question: 'Probe the agent through its own interface', rawAnswer: '', facts: unmeasuredFacts(), ...(exception ? { isolation: KEYCHAIN_READ_ONLY, auth: 'owner subscription sign-in' } : {}), fixtureRoot: fixture.root }
  if (!fixture.isolation.preflightPassed || !agentHomeIsIsolated(agent, fixture)) return { ...base, status: 'could-not-ask', reason: 'cannot isolate' }
  const probe = PROBES.get(agent.id)
  if (!probe) return { ...base, status: 'could-not-ask', reason: 'no safe probe registered' }
  try {
    const answer = await probe(agent, fixture)
    if (answer.status === 'could-not-ask') {
      const reason = typeof answer.reason === 'string' && safeText(answer.reason, fixture) ? answer.reason : 'probe failed safely'
      const facts = answer.facts && Object.keys(answer.facts).every((key) => FACT_KEYS.has(key)) && safeFact(answer.facts, fixture) ? { ...unmeasuredFacts(), ...answer.facts } : base.facts
      return { ...base, interface: safeText(answer.interface, fixture) ? answer.interface : base.interface, question: safeText(answer.question, fixture) ? answer.question : base.question, facts, status: 'could-not-ask', reason }
    }
    const normalizedRaw = redact(answer.rawAnswer ?? '', fixtureTokens(fixture), fixture.root)
    const signedOutStatus = answer.facts?.signedOutCatalogue?.status ?? answer.facts?.signedOutCatalogue
    const observedSignedOutOutcome = ['available', 'empty'].includes(signedOutStatus) || ['no-session', 'session-created'].includes(answer.facts?.signedOutCatalogue?.observation)
    if (!normalizedRaw && !observedSignedOutOutcome) return { ...base, status: 'could-not-ask', reason: 'answer failed the fixture-only privacy allowlist' }
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
  for (const oldName of await readdir(directory)) {
    if (oldName.startsWith(`${agentSlug}-`) && oldName.endsWith('.json') && join(directory, oldName) !== path) await unlink(join(directory, oldName))
  }
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  return path
}

export async function findAgentInstall(agent, fixture) {
  const { candidatePaths, findInstalls, judgeInstalls } = await import('../../packages/server/dist/src/installs/locate.js')
  const spec = agent.id === 'codex'
    ? { commands: ['codex'], versionArgs: ['--version'] }
    : agent.cli
  const locateOptions = { home: homedir(), env: { PATH: process.env.PATH ?? '' } }
  const candidatePathsAll = candidatePaths(spec, locateOptions)
  const candidates = []
  const unreadablePaths = []
  for (const path of candidatePathsAll) {
    try {
      if (statSync(path).isFile()) candidates.push(path)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) unreadablePaths.push(path)
    }
  }
  const realHome = realpathSync(homedir())
  const declared = agent.id === 'codex' ? '~/.codex' : agent.home?.path
  if (!declared) return { chosen: null, copies: [], state: 'unsafe' }
  const agentHome = declared.startsWith('~/') ? join(realHome, declared.slice(2)) : resolve(realHome, declared)
  const copyRoots = []
  const unsafeCopies = []
  const candidateRecords = []
  for (const path of candidates) {
    try {
      const realPath = realpathSync(path)
      const installRoot = installReadRoot(realPath)
      if (installRoot && !installRootIsSafe(installRoot, realHome)) {
        unsafeCopies.push({ path, reason: 'cannot isolate: install directory contains the real home' })
        continue
      }
      if (isWithin(realHome, realPath) && (!installRoot || !isWithin(agentHome, installRoot) && !isWithin(realHome, installRoot) || installRoot === agentHome || CREDENTIAL_ROOTS.some((root) => installRoot === join(realHome, root)))) {
        unsafeCopies.push({ path, reason: 'cannot isolate: install directory overlaps agent configuration' })
        continue
      }
      if (!installRoot) {
        unsafeCopies.push({ path, reason: 'cannot isolate: install runtime boundary unavailable' })
        continue
      }
      copyRoots.push(installRoot)
      candidateRecords.push({ path, realPath, installRoot })
    } catch {
      candidateRecords.push({ path, unreadable: true })
    }
  }
  if (unsafeCopies.length && !candidateRecords.length && !unreadablePaths.length) return { chosen: null, copies: unsafeCopies, state: installDiscoveryState({ candidateCount: candidates.length, copies: unsafeCopies, unsafeCount: unsafeCopies.length }) }
  const isolation = KEYCHAIN_READ_ONLY_AGENTS.has(agent.id) ? KEYCHAIN_READ_ONLY : 'strict'
  if (!await prepareSandbox(fixture, { isolation, readPaths: copyRoots })) return { chosen: null, copies: [], state: 'unsafe' }
  if (!agentHomeIsIsolated(agent, fixture)) return { chosen: null, copies: [], state: 'unsafe' }
  if (!candidates.length) {
    const copies = [...unsafeCopies, ...unreadablePaths.map((path) => ({ path, standing: 'unreadable' }))]
    return { chosen: null, copies, state: installDiscoveryState({ candidateCount: unreadablePaths.length + unsafeCopies.length, copies, unsafeCount: unsafeCopies.length }) }
  }
  if (!candidateRecords.length) return { chosen: null, copies: unsafeCopies, state: 'unsafe' }
  const found = await findInstalls(spec, {
    ...locateOptions,
    probe: async (path, args) => {
      try {
        const candidate = candidateRecords.find((entry) => entry.path === path)
        if (!candidate || candidate.unreadable) return null
        const result = await run(candidate.realPath, [...args], fixture, { timeoutMs: 10_000 })
        return result.code === 0 ? `${result.stdout}\n${result.stderr}` : null
      } catch {
        return null
      }
    },
  })
  const judged = judgeInstalls(found, { minVersion: spec.minVersion })
  const copies = [...judged.copies, ...unsafeCopies, ...unreadablePaths.map((path) => ({ path, standing: 'unreadable' }))]
  const chosen = judged.chosen ? { ...judged.chosen, path: judged.chosen.realPath } : null
  return { chosen, copies, state: installDiscoveryState({ candidateCount: candidates.length, copies, chosen, unsafeCount: unsafeCopies.length }) }
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
      const installResult = await findAgentInstall(agent, fixture)
      const install = installResult.chosen
      const command = install?.path
      const discovered = command
        ? await captureHelpVersion({ ...agent, command }, fixture)
        : null
      const result = command && discovered?.value && discovered.value === install.version && shouldAskAgent(agent)
        ? await askAgent({ ...agent, command, version: discovered.value }, fixture)
        : command && discovered?.value && discovered.value === install.version
          ? {
              agent: agent.name, agentId: agent.id, version: discovered.value, measured: new Date().toISOString().slice(0, 10),
              interface: 'not launched', question: 'Is an installed build available?', rawAnswer: '', facts: unmeasuredFacts(),
              status: 'could-not-ask', isolation: KEYCHAIN_READ_ONLY, auth: 'owner subscription sign-in', reason: 'needs sign-in, not measured',
            }
        : {
            agent: agent.name, agentId: agent.id, version: 'unknown', measured: new Date().toISOString().slice(0, 10),
            interface: 'not launched', question: 'Is an installed build available?', rawAnswer: '', facts: unmeasuredFacts(),
            status: 'could-not-ask',
            ...(fixture.isolation.profile === KEYCHAIN_READ_ONLY ? { isolation: KEYCHAIN_READ_ONLY, auth: 'owner subscription sign-in' } : {}),
            reason: !fixture.isolation.available || installResult.state === 'unsafe' ? 'cannot isolate' : installResult.state === 'absent' ? 'binary not installed' : installResult.state === 'unreadable' ? 'installed candidate version unreadable' : installResult.state === 'below-floor' ? 'installed version below supported floor' : !discovered?.value ? 'could not capture an exact version' : 'installed version changed during discovery',
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
