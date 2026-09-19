import { constants } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ConfigOption } from '@harnessdesk/protocol'

export const CODEX_PROFILE_OPTION_ID = 'codexProfile'

const PROFILE_SUFFIX = '.config.toml'
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_PROFILE_FILES = 64
const MAX_PROFILE_BYTES = 64 * 1024
const MAX_MODEL_BYTES = 128
const MIN_TOKENS = 1
const MAX_TOKENS = 10_000_000

export interface CodexProfileConfig {
  readonly model_context_window?: number
  readonly model_auto_compact_token_limit?: number
}

export interface CodexProfile {
  readonly id: string
  readonly model?: string
  readonly config: CodexProfileConfig
}

export interface CodexProfileEntry {
  readonly id: string
  readonly profile?: CodexProfile
  readonly error?: string
}

const rootOf = (home: string | null): string =>
  home ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')

const filenameOf = (id: string): string => {
  if (!PROFILE_NAME.test(id)) throw new Error('A profile name must use 1–64 letters, numbers, hyphens or underscores.')
  return `${id}${PROFILE_SUFFIX}`
}

/**
 * Reads one regular UTF-8 profile file without trusting its size. A Codex
 * account slot links the owner's profile files into its isolated home, so a
 * link to a regular file is accepted; the opened descriptor still has to be
 * regular. Only the three root settings this feature can carry are parsed;
 * commands, instructions, MCP tables and every other key remain inert text.
 */
export const readCodexProfile = async (home: string | null, id: string): Promise<CodexProfile> => {
  const filename = filenameOf(id)
  let file
  try {
    file = await open(
      join(rootOf(home), filename),
      constants.O_RDONLY | constants.O_NONBLOCK,
    )
  } catch {
    throw new Error(`${filename} could not be read.`)
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error(`${filename} is not a regular file.`)
    if (stat.size > MAX_PROFILE_BYTES) throw new Error(`${filename} is larger than 64 KiB.`)
    const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (part.bytesRead === 0) break
      bytesRead += part.bytesRead
    }
    if (bytesRead > MAX_PROFILE_BYTES) throw new Error(`${filename} is larger than 64 KiB.`)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    } catch {
      throw new Error(`${filename} is not valid UTF-8.`)
    }
    return parseProfile(id, filename, text)
  } finally {
    await file.close()
  }
}

/** Lists at most 64 direct profile names in display order. */
export const listCodexProfiles = async (home: string | null): Promise<readonly CodexProfileEntry[]> => {
  let directory
  try {
    directory = await opendir(rootOf(home))
  } catch {
    return []
  }
  const names: string[] = []
  try {
    for await (const entry of directory) {
      if (!entry.name.endsWith(PROFILE_SUFFIX)) continue
      const id = entry.name.slice(0, -PROFILE_SUFFIX.length)
      if (!PROFILE_NAME.test(id)) continue
      names.push(id)
      if (names.length === MAX_PROFILE_FILES) break
    }
  } finally {
    await directory.close().catch(() => {})
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return Promise.all(
    names.map(async (id): Promise<CodexProfileEntry> => {
      try {
        return { id, profile: await readCodexProfile(home, id) }
      } catch (error) {
        return { id, error: error instanceof Error ? error.message : `${id}${PROFILE_SUFFIX} could not be read.` }
      }
    }),
  )
}

/** The start-only option added to the runtime's ordinary new-session list. */
export const profileOption = (
  entries: readonly CodexProfileEntry[],
  selected = '',
): Extract<ConfigOption, { type: 'select' }> => {
  const choices = [
    {
      value: '',
      label: 'None',
      description: 'Use the ordinary configuration unchanged.',
    },
    ...entries.map((entry) => ({
      value: entry.id,
      label: entry.id,
      description: entry.error ?? `Reads ${entry.id}${PROFILE_SUFFIX} when the conversation starts.`,
      ...(entry.error ? { disabled: entry.error } : {}),
    })),
  ]
  if (selected && !entries.some((entry) => entry.id === selected)) {
    choices.push({
      value: selected,
      label: selected,
      description: `${selected}${PROFILE_SUFFIX} no longer exists.`,
      disabled: `${selected}${PROFILE_SUFFIX} no longer exists.`,
    })
  }
  return {
    type: 'select',
    id: CODEX_PROFILE_OPTION_ID,
    category: 'other',
    label: 'Profile',
    description: 'Applied only to new conversations. The context ring shows the window the agent reports.',
    currentValue: selected,
    choices,
  }
}

const parseProfile = (id: string, filename: string, text: string): CodexProfile => {
  const found = new Map<string, string>()
  let root = true
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw).trim()
    if (!line) continue
    if (line.startsWith('[')) {
      root = false
      continue
    }
    if (!root) continue
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    if (!assignment) continue
    const key = assignment[1]!
    if (!['model', 'model_context_window', 'model_auto_compact_token_limit'].includes(key)) continue
    if (found.has(key)) throw new Error(`${filename} sets ${key} more than once.`)
    found.set(key, assignment[2]!.trim())
  }
  if (found.size === 0) {
    throw new Error(`${filename} has no supported model or context settings.`)
  }
  const model = found.has('model') ? parseModel(filename, found.get('model')!) : undefined
  const context = found.has('model_context_window')
    ? parseTokens(filename, 'model_context_window', found.get('model_context_window')!)
    : undefined
  const compact = found.has('model_auto_compact_token_limit')
    ? parseTokens(filename, 'model_auto_compact_token_limit', found.get('model_auto_compact_token_limit')!)
    : undefined
  if (context !== undefined && compact !== undefined && compact > context) {
    throw new Error(`${filename} compacts after its context window ends.`)
  }
  return {
    id,
    ...(model ? { model } : {}),
    config: {
      ...(context !== undefined ? { model_context_window: context } : {}),
      ...(compact !== undefined ? { model_auto_compact_token_limit: compact } : {}),
    },
  }
}

const parseModel = (filename: string, raw: string): string => {
  let value: string
  try {
    if (raw.startsWith('"') && raw.endsWith('"')) value = JSON.parse(raw) as string
    else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1)
    else throw new Error('not a string')
  } catch {
    throw new Error(`${filename} has an invalid model string.`)
  }
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_MODEL_BYTES || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${filename} has a model outside the supported 1–128 byte range.`)
  }
  return value
}

const parseTokens = (filename: string, key: string, raw: string): number => {
  if (!/^\d(?:_?\d)*$/.test(raw)) throw new Error(`${filename} has an invalid ${key}.`)
  const value = Number(raw.replaceAll('_', ''))
  if (!Number.isSafeInteger(value) || value < MIN_TOKENS || value > MAX_TOKENS) {
    throw new Error(`${filename} has ${key} outside the supported 1–10,000,000 token range.`)
  }
  return value
}

/** Removes a TOML comment without treating a hash inside a quoted value as one. */
const withoutComment = (line: string): string => {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote === '"' && escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? null : quote ?? char
      continue
    }
    if (char === '#' && quote === null) return line.slice(0, index)
  }
  return line
}
