import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools'

export interface DeveloperToolsOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Safe selection and filesystem probes, replaceable in tests. Never runs a developer tool. */
  readonly selectedDirectory?: () => string
  readonly isDirectory?: (path: string) => boolean
  readonly log?: (message: string) => void
}

/**
 * An explicit workaround for the macOS git shim's Xcode first-launch check
 * inside an agent sandbox. Kept in the agents' extra environment: the host
 * and its plugins still use the person's developer tools. Defaulting this
 * on would break Xcode builds, so neither the system selection nor any
 * explicit DEVELOPER_DIR is changed.
 */
export const developerToolsEnvironment = (options: DeveloperToolsOptions = {}): Readonly<Record<string, string>> => {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== 'darwin' ||
    env['HARNESSDESK_COMMAND_LINE_TOOLS'] !== '1' || env['DEVELOPER_DIR'] !== undefined) return {}
  try {
    if (!(options.isDirectory ?? ((path) => statSync(path).isDirectory()))(COMMAND_LINE_TOOLS)) return {}
    // Only the explicitly opted-in startup pays for this bounded selection
    // read. xcode-select -p reads configuration; git/xcrun are never probed.
    const selected = (options.selectedDirectory ?? (() => execFileSync('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    })))().trim()
    if (!/\.app\/Contents\/Developer\/?$/.test(selected)) return {}
  } catch {
    return {}
  }
  options.log?.('HARNESSDESK_COMMAND_LINE_TOOLS=1: agents use Command Line Tools. Xcode tools, including iOS builds, need an explicit DEVELOPER_DIR; unset the opt-in and restart to undo.')
  return { DEVELOPER_DIR: COMMAND_LINE_TOOLS }
}
