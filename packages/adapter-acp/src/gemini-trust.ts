import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface GeminiTrustOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
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

const canonical = (path: string): string => {
  try { return realpathSync(path) } catch { return resolve(path) }
}

const normalize = (path: string): string => {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

const contains = (parent: string, child: string): boolean => {
  const rel = relative(normalize(parent), normalize(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Read-only mirror of Gemini CLI's checkPathTrust/loadTrustedFolders rules. */
export const geminiTrustsFolder = (target: string, options: GeminiTrustOptions = {}): boolean => {
  const env = options.env ?? process.env
  if (env['GEMINI_RESTRICTED_MODE'] === 'true' || env['GEMINI_CLI_TRUST_WORKSPACE'] === 'false') return false
  if (env['GEMINI_CLI_TRUST_WORKSPACE'] === 'true') return true

  const home = env['GEMINI_CLI_HOME'] || options.home || env['HOME'] || homedir()
  const settings = readJson(join(home, '.gemini', 'settings.json'))
  const security = object(settings) && object(settings['security']) ? settings['security'] : null
  const folderTrust = security && object(security['folderTrust']) ? security['folderTrust'] : null
  // Gemini's settings schema defaults `security.folderTrust.enabled` to true.
  // Its trust resolver bypasses the trusted-folders file only when disabled.
  if (folderTrust?.['enabled'] === false) return true

  const trustedPath = env['GEMINI_CLI_TRUSTED_FOLDERS_PATH'] || join(home, '.gemini', 'trustedFolders.json')
  if (!existsFile(trustedPath)) return false
  const parsed = readJson(trustedPath)
  if (!object(parsed)) return false

  const location = canonical(target)
  let longest = -1
  let decision: string | undefined
  for (const [rulePath, trustLevel] of Object.entries(parsed)) {
    if (trustLevel !== 'TRUST_FOLDER' && trustLevel !== 'TRUST_PARENT' && trustLevel !== 'DO_NOT_TRUST') return false
    const normalizedRule = normalize(rulePath)
    const effectivePath = trustLevel === 'TRUST_PARENT' ? dirname(normalizedRule) : normalizedRule
    if (contains(canonical(effectivePath), location) && normalizedRule.length > longest) {
      longest = normalizedRule.length
      decision = trustLevel
    }
  }
  return decision === 'TRUST_FOLDER' || decision === 'TRUST_PARENT'
}

const existsFile = (path: string): boolean => {
  try { return statSync(path).isFile() } catch { return false }
}
