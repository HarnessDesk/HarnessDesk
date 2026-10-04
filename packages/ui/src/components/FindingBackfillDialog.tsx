import type { FindingPublicationsView } from '@harnessdesk/protocol'
import { ConfirmDialog, Note, Text } from '../design'
import { RECORD_REASON } from '../lib/team-record'
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A backfill is confirmed against exactly the host's stamped preview. */
export const FindingBackfillDialog = ({ backfill, busy, record = false, onCancel, onConfirm }: {
  backfill: NonNullable<FindingPublicationsView['backfill']>
  busy: boolean
  record?: boolean
  onCancel: () => void
  onConfirm: () => void
}) => <ConfirmDialog title="Post earlier rounds" tone="default" confirmLabel={`Post to #${backfill.pr}`} busy={busy} pending={record} onCancel={onCancel} onConfirm={onConfirm}>
  <div className="flex flex-col gap-1">
    {record && <Note>{RECORD_REASON}</Note>}
    {backfill.rounds.map(one => <Text key={one.round} as="p" role="prose">{`Round ${one.round}: ${plural(one.findings, 'finding', 'findings')} and ${plural(one.reviews, 'review', 'reviews')}`}</Text>)}
    <Text as="p" role="meta">Each comment names the Agent that made its claim and the revision it read. One reviewed at a revision the pull request has moved past waits for you.</Text>
  </div>
</ConfirmDialog>
