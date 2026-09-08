import type { AcpRegistryAgentInfo } from '@harnessdesk/protocol'

/**
 * The ACP registry as the interface lists it — the pure half.
 *
 * The host answers with every agent the registry names and whether this
 * machine can run each one; what the surfaces need on top is small and the
 * same everywhere: an order that puts the addable before the blocked, a
 * search that reads the words a person actually knows the agent by, and the
 * one sentence a row wears under its name.
 */

/**
 * Addable first, then the blocked — each half alphabetical. Registered
 * entries keep their place: on the settings list they wear a chip instead of
 * moving, and the sign-in rail filters them out before ordering.
 */
export const registryOrder = (
  agents: readonly AcpRegistryAgentInfo[],
): readonly AcpRegistryAgentInfo[] =>
  [...agents].sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )

/** Whether typed text finds this entry — its name, its id, or its sentence. */
export const registryMatches = (agent: AcpRegistryAgentInfo, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [agent.name, agent.id, agent.description ?? '']
    .some((word) => word.toLowerCase().includes(needle))
}

/**
 * The row's sentence. An addable agent gets its own description — the
 * registry's words, not ours; a blocked one gets the reason, because the
 * subtitle is where "why not" belongs. Null when there is nothing worth a
 * second line, per the second-line rule.
 */
export const registrySentence = (agent: AcpRegistryAgentInfo): string | null => {
  if (agent.installed && !agent.registered) return installedSentence(agent)
  if (!agent.available && agent.reason) return agent.reason
  return agent.description ?? null
}

/**
 * The line for an entry whose agent is already on the machine: which copy
 * would answer. The fact matters more than the description here — a person
 * who installed the thing knows what it is.
 *
 * Just the fact. That adding downloads nothing is already on the button,
 * which reads Add rather than Download for exactly these entries, and the
 * cell gives its sentence two lines — into which a version and the longest
 * channel label fit, and a second clause does not.
 */
export const installedSentence = (agent: AcpRegistryAgentInfo): string | null => {
  const copy = agent.installed
  if (!copy) return null
  return `Already installed${copy.version ? ` — ${copy.version}` : ''} via ${copy.channelLabel}.`
}

/**
 * What the button does, said on the button — before it happens. A binary
 * entry's click starts a download, so its idle label already says so; a
 * package-runner entry only writes a row.
 */
export const registryAddLabel = (agent: AcpRegistryAgentInfo, busy: boolean): string => {
  const downloads = agent.run === 'binary' && !agent.installed
  if (busy) return downloads ? 'Downloading…' : 'Adding…'
  return downloads ? 'Download' : 'Add'
}

/**
 * How the agent will run, for the detail pane — the one fact that differs by
 * channel: a package runner fetches on first start, a binary is downloaded
 * by HarnessDesk at add time and deleted again when the agent is removed.
 */
export const registryRunSentence = (agent: AcpRegistryAgentInfo): string => {
  if (agent.installed) {
    return `Runs the copy already on this machine (${agent.installed.path}); the registry's own build stays one update away as a fallback.`
  }
  return agent.run === 'binary'
    ? `Adding it downloads the agent's own build for this machine into HarnessDesk's data folder; removing the agent deletes the download too.`
    : `Runs through ${agent.run}, which fetches the agent on first start — nothing to install now.`
}
