import type { FindingPublicationsView } from '@harnessdesk/protocol'
import { ConfirmDialog, Text } from '../design'
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A backfill is confirmed against exactly the host's stamped preview. */
export const FindingBackfillDialog = ({ backfill, busy, onCancel, onConfirm }: {
  backfill: NonNullable<FindingPublicationsView['backfill']>
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) => <ConfirmDialog title="Post earlier rounds" tone="default" confirmLabel={`Post to #${backfill.pr}`} busy={busy} onCancel={onCancel} onConfirm={onConfirm}>
  <div className="flex flex-col gap-1">
    {backfill.rounds.map(one => <Text key={one.round} as="p" role="prose">{`Round ${one.round}: ${plural(one.findings, 'finding', 'findings')} and ${plural(one.reviews, 'review', 'reviews')}`}</Text>)}
    <Text as="p" role="meta">Each comment names the Agent that made its claim and the revision it read. One reviewed at a revision the pull request has moved past waits for you.</Text>
  </div>
</ConfirmDialog>
