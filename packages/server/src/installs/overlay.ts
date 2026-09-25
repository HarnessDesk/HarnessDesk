import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { usageRecordFor } from '../usage/antigravity-store.js'
import { identityReaderFor } from './identity.js'
import { providerReaderFor } from './provider.js'
import { currentNameOf, type KnownAgent } from './known-agents.js'

/**
 * What the desk lays over a row for an agent it knows: today's name where
 * the row still carries a retired one, a reader for who the agent is signed
 * in as, a reader for which vendor its models come from, and the store an agent that counts usage off the wire keeps it in.
 *
 * One function, so the path that spawns agents and the test that holds it
 * read the same thing — the spawn path is a closure inside the host's own
 * construction, which no test builds.
 */
export const knowledgeOverlay = (
  agent: AcpAgentConfig,
  known: Pick<KnownAgent, 'id' | 'name' | 'formerNames' | 'auth'> | undefined,
  options: {
    /** The environment the agent is started with. Defaults to the host's, under the row's own. */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Where a changed vendor format is reported; see `AntigravityStoreOptions.warn`. */
    readonly warn?: (message: string, details?: unknown) => void
  } = {},
): Pick<AcpAgentConfig, 'name' | 'resolveIdentity' | 'resolveProvider' | 'usageRecord' | 'account'> => {
  const env = options.env ?? { ...process.env, ...agent.env }
  const resolveIdentity = identityReaderFor(known, {
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    env,
  })
  // Which vendor its models come from, read from its own configuration; see `installs/provider.ts`.
  const resolveProvider = providerReaderFor(known, { env })
  const usageRecord = usageRecordFor(known, { env, ...(options.warn ? { warn: options.warn } : {}) })
  const account = known?.auth && (known.auth.status || known.auth.login || known.auth.logout)
    ? {
        ...(known.auth.status ? { status: known.auth.status } : {}),
        ...(known.auth.login ? { login: known.auth.login } : {}),
        ...(known.auth.logout ? { logout: known.auth.logout } : {}),
      }
    : undefined
  return {
    name: currentNameOf(known, agent.name),
    ...(resolveIdentity ? { resolveIdentity } : {}),
    ...(resolveProvider ? { resolveProvider } : {}),
    ...(usageRecord ? { usageRecord } : {}),
    ...(account ? { account } : {}),
  }
}
