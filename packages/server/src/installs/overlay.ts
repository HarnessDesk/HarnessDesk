import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { usageRecordFor } from '../usage/antigravity-store.js'
import { identityReaderFor, identityStatusReaderFor } from './identity.js'
import { providerReaderFor } from './provider.js'
import { currentNameOf, knownAgentByCommand, type KnownAgent } from './known-agents.js'
import { commandName } from './service.js'

/**
 * What the desk lays over a row for an agent it knows: today's name where
 * the row still carries a retired one, a reader for who the agent is signed
 * in as, a reader for which vendor its models come from, the store an agent that counts usage off the wire keeps it in,
 * and the keys the desk can hold for it. A key reaches the row only once how
 * the agent takes it has been measured — named by the ACP method it answers
 * (#1760). The rest of the table's keys stay descriptions until then: an
 * optional key beside a sign-in the agent already chose may simply be
 * ignored, and the card would claim a key sign-in that never happened. A row
 * that already names its own keys — a template's — keeps them.
 *
 * One function, so the path that spawns agents and the test that holds it
 * read the same thing — the spawn path is a closure inside the host's own
 * construction, which no test builds.
 */
export const knowledgeOverlay = (
  agent: AcpAgentConfig,
  known: (Pick<KnownAgent, 'id' | 'name' | 'formerNames' | 'auth'> & Partial<Pick<KnownAgent, 'acp'>>) | undefined,
  options: {
    /** The environment the agent is started with. Defaults to the host's, under the row's own. */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Where a changed vendor format is reported; see `AntigravityStoreOptions.warn`. */
    readonly warn?: (message: string, details?: unknown) => void
  } = {},
): Pick<AcpAgentConfig, 'name' | 'coAuthor' | 'resolveIdentity' | 'resolveIdentityStatus' | 'identityIsStatus' | 'resolveProvider' | 'usageRecord' | 'account' | 'sharedSessionProcess' | 'secrets' | 'authMethodNotes'> => {
  const env = options.env ?? { ...process.env, ...agent.env }
  const measuredKeys = agent.secrets ? [] : (known?.auth?.secrets ?? []).filter((secret) => secret.acpMethod !== undefined)
  const resolveIdentity = identityReaderFor(known, {
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    env,
    ...(env['HOME'] ? { home: env['HOME'] } : {}),
  })
  const resolveIdentityStatus = identityStatusReaderFor(known, {
    env,
    ...(env['HOME'] ? { home: env['HOME'] } : {}),
  })
  // Which vendor its models come from, read from its own configuration; see
  // `installs/provider.ts`. The row's own args go along too — DSH's reader
  // needs them to see a launch flag its files would never mention.
  const resolveProvider = providerReaderFor(known, { env, ...(agent.args ? { args: agent.args } : {}) })
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
    coAuthor: knownAgentByCommand(commandName(agent.executable?.command ?? agent.command))?.coAuthor ?? null,
    ...(known?.acp?.sharedSessionProcess ? { sharedSessionProcess: true } : {}),
    ...(resolveIdentity ? { resolveIdentity } : {}),
    ...(resolveIdentityStatus ? { resolveIdentityStatus } : {}),
    ...(known?.id === 'opencode' ? { identityIsStatus: true } : {}),
    ...(resolveProvider ? { resolveProvider } : {}),
    ...(usageRecord ? { usageRecord } : {}),
    ...(account ? { account } : {}),
    ...(measuredKeys.length > 0 ? { secrets: measuredKeys } : {}),
    ...(known?.auth?.acpMethodNotes ? { authMethodNotes: known.auth.acpMethodNotes } : {}),
  }
}
