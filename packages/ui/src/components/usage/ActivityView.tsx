import type { RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import { UsageActivity } from '../UsageActivity'

/** Activity: when it ran, full width — the heatmap alone, scoped like every other view. */
export const ActivityView = ({
  byId,
  scope,
  now,
  scanFinishedAt,
}: {
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  now: number
  scanFinishedAt: number | null | undefined
}) => <UsageActivity byId={byId} scope={scope} now={now} scanFinishedAt={scanFinishedAt} />
