import { randomUUID } from 'node:crypto'

/** Test-only process identity for the multi-process fake Codex rig. */
export const testProcessEnv = (env: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(),
  HARNESSDESK_CODEX_GENERATION: '0',
  ...env,
})
