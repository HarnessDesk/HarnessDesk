import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const HOME = process.env['HD_SHOTS_HOME'] ?? join(homedir(), '.harnessdesk-shots')
export const WORK = process.env['HD_SHOTS_WORK'] ?? join(homedir(), 'work')

// The built-in adapter is constructed even when a camera ACP row replaces it.
// Capture and seed both use this inert configuration; importing it never stages
// or clears the desk.
export const SHOT_ENV = {
  ...process.env,
  CODEX_HOME: join(HOME, 'codex-home'),
  HARNESSDESK_CODEX_BINARY: join(APP, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  FAKE_CODEX_VERSION_FILE: join(HOME, 'codex-version'),
}
