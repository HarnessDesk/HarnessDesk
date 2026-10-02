import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface GeminiTrustOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
}

export interface GeminiTrustStatus {
  readonly trusted: boolean
  /** True when Gemini would stop startup because trusted-folders data is unreadable or invalid. */
  readonly unavailable: boolean
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Gemini strips JSON comments before parsing its trusted-folders file. */
const withoutComments = (source: string): string => {
  let result = ''
  let quote = false
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (quote) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') { quote = true; result += char; continue }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      result += '\n'
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      result += ' '
      continue
    }
    result += char
  }
  return result
}

const readJson = (path: string): unknown => {
  try { return JSON.parse(withoutComments(readFileSync(path, 'utf8'))) as unknown } catch { return null }
}

const settingsAt = (path: string): Record<string, unknown> => {
  const parsed = readJson(path)
  return object(parsed) ? parsed : {}
}

const settingsPath = (env: Readonly<Record<string, string | undefined>>, home: string): string => {
  const cliHome = env['GEMINI_CLI_HOME'] || home
  return join(cliHome, '.gemini', 'settings.json')
}

const systemSettingsPath = (env: Readonly<Record<string, string | undefined>>): string => {
  if (env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']) return env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json'
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json'
  return '/etc/gemini-cli/settings.json'
}

const systemDefaultsPath = (env: Readonly<Record<string, string | undefined>>, systemPath: string): string =>
  env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] || join(dirname(systemPath), 'system-defaults.json')

const canonical = (path: string): string => {
  try { return realpathSync(path) } catch { return resolve(path) }
}

const normalize = (path: string): string => {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.replaceAll('\\', '/').toLowerCase() : resolved
}

const contains = (parent: string, child: string): boolean => {
  const rel = relative(normalize(parent), normalize(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Read-only mirror of Gemini CLI's initial settings fold and checkPathTrust/loadTrustedFolders rules. */
export const geminiTrustsFolderStatus = (target: string, options: GeminiTrustOptions = {}): GeminiTrustStatus => {
  const env = options.env ?? process.env
  if (env['GEMINI_RESTRICTED_MODE'] === 'true' || env['GEMINI_CLI_TRUST_WORKSPACE'] === 'false') {
    return { trusted: false, unavailable: false }
  }
  if (env['GEMINI_CLI_TRUST_WORKSPACE'] === 'true') return { trusted: true, unavailable: false }

  const home = env['GEMINI_CLI_HOME'] || options.home || env['HOME'] || homedir()
  const sysPath = systemSettingsPath(env)
  const layers = [
    // The schema default is true; explicit values then follow Gemini's initial
    // trust check order, with the system file taking final precedence.
    { security: { folderTrust: { enabled: true } } },
    settingsAt(systemDefaultsPath(env, sysPath)),
    settingsAt(settingsPath(env, home)),
    settingsAt(sysPath),
  ]
  let folderTrustEnabled = true
  for (const layer of layers) {
    const security = object(layer['security']) ? layer['security'] : null
    const folderTrust = security && object(security['folderTrust']) ? security['folderTrust'] : null
    if (typeof folderTrust?.['enabled'] === 'boolean') folderTrustEnabled = folderTrust['enabled']
  }
  if (!folderTrustEnabled) return { trusted: true, unavailable: false }

  const trustedPath = env['GEMINI_CLI_TRUSTED_FOLDERS_PATH'] || join(home, '.gemini', 'trustedFolders.json')
  // Gemini treats anything at that path as its file and fails to read a
  // directory; only nothing at all there means "no folders trusted yet".
  if (!existsPath(trustedPath)) return { trusted: false, unavailable: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutComments(readFileSync(trustedPath, 'utf8'))) as unknown
  } catch {
    return { trusted: false, unavailable: true }
  }
  if (!object(parsed)) return { trusted: false, unavailable: true }

  const location = canonical(target)
  let longest = -1
  let decision: string | undefined
  for (const [rulePath, trustLevel] of Object.entries(parsed)) {
    if (trustLevel !== 'TRUST_FOLDER' && trustLevel !== 'TRUST_PARENT' && trustLevel !== 'DO_NOT_TRUST') {
      return { trusted: false, unavailable: true }
    }
    const normalizedRule = normalize(rulePath)
    const effectivePath = trustLevel === 'TRUST_PARENT' ? dirname(normalizedRule) : normalizedRule
    if (contains(canonical(effectivePath), location) && normalizedRule.length > longest) {
      longest = normalizedRule.length
      decision = trustLevel
    }
  }
  return { trusted: decision === 'TRUST_FOLDER' || decision === 'TRUST_PARENT', unavailable: false }
}

export const geminiTrustsFolder = (target: string, options: GeminiTrustOptions = {}): boolean =>
  geminiTrustsFolderStatus(target, options).trusted


const existsPath = (path: string): boolean => {
  try { statSync(path); return true } catch { return false }
}
