import type { AgentEntry } from '@harnessdesk/protocol'

import { brandForRuntime } from '../lib/brands'
import { markFor, seatTaken } from '../lib/agents'
import { useSnapshot } from '../state/context'
import { IconTile, Monogram } from '../design'
import { RuntimeMark } from './BrandIcons'

const initials = (name: string): string =>
  (name.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 2).map((part) => Array.from(part)[0] ?? '').join('').toLocaleUpperCase()

/** A seated Agent wears its runtime's mark; one without one gets its own initials. */
export const AgentFace = ({ entry }: { readonly entry: AgentEntry }) => {
  const snapshot = useSnapshot()
  const candidate = seatTaken(snapshot.agentPlans.get(entry.id))
  const runtime = candidate ? markFor(candidate, snapshot.runtimes) : null
  return (
    <IconTile shape="face" {...(candidate ? { title: candidate.runtimeName } : {})}>
      {runtime && brandForRuntime(runtime)
        ? <RuntimeMark runtime={runtime} size={16} />
        : <Monogram>{initials(entry.definition?.name ?? entry.id)}</Monogram>}
    </IconTile>
  )
}
