import type { ReactNode } from 'react'
import { Card, CardViewport } from '../ui/card'
import { Button } from '../ui/button'
import { Text } from './Settings'
import { CheckIcon, RefreshIcon } from '../../components/Icons'
import { IconTile } from '../ui/icon-tile'

/** A recorded recommendation and the person's next decision, above the shared composer. */
export const ComparisonDecision = ({ title, reason, mergeLabel, mergeRefusal, onMerge, onRefresh, onCompare, compareRefusal, keepLabel, onKeep }: {
  title: string
  reason?: ReactNode
  mergeLabel: string
  mergeRefusal?: string
  onMerge: () => void
  onRefresh?: () => void
  onCompare: () => void
  compareRefusal?: string
  keepLabel?: string
  onKeep?: () => void
}) => <Card spacing="compact" data-slot="comparison-decision" role="group" aria-label="Your decision">
  <div className="flex min-w-0 items-start gap-3">
    <IconTile size="sm" tone="success" aria-hidden><CheckIcon size={14} /></IconTile>
    <div className="min-w-0 flex-1">
      <Text role="row" as="div">{title}</Text>
      {reason && <CardViewport size="lines" maxLines={4} tabIndex={0} aria-label="Judge reason"><Text role="meta" as="div" className="break-words">{reason}</Text></CardViewport>}
    </div>
  </div>
  <div className="flex flex-wrap items-center justify-end gap-2">
    {onRefresh && <Button variant="ghost" size="icon-sm" aria-label="Refresh merge destination" title="Refresh destination" onClick={onRefresh}><RefreshIcon size={14} /></Button>}
    {onKeep && keepLabel && <Button variant="ghost" size="sm" onClick={onKeep}>{keepLabel}</Button>}
    <Button variant="outline" size="sm" disabled={Boolean(compareRefusal)} title={compareRefusal} onClick={onCompare}>Compare changes</Button>
    <Button size="sm" disabled={Boolean(mergeRefusal)} title={mergeRefusal} onClick={onMerge}>{mergeLabel}</Button>
  </div>
</Card>
