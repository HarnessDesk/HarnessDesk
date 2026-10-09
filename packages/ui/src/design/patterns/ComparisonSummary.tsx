import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { Card, CardContent } from '../ui/card'
import { KeyValue, KeyValueRow } from '../ui/key-value'
import { Text } from './Settings'
import { PaneColumn } from './PaneColumn'

/** The reading page in the same Side by side body, once the person has merged. */
export const ComparisonSummary = ({ title, meta, attempts, checks, judge, onShowAttempts, onRaceAgain }: {
  title: string
  meta: ReactNode
  attempts: ReactNode
  checks: ReactNode
  judge: ReactNode
  onShowAttempts: () => void
  onRaceAgain?: () => void
}) => <PaneColumn inset="reading" page className="h-full overflow-auto" data-slot="comparison-summary">
  <div className="mx-auto flex max-w-(--hd-column) flex-col gap-5">
    <div>
      <Text role="section" as="h2" className="m-0">{title}</Text>
      <Text role="meta" as="div" className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{meta}</Text>
    </div>
    {attempts}
    <Card spacing="compact"><CardContent inset="none"><KeyValue variant="panel">
      <KeyValueRow label="Checks" variant="panel">{checks}</KeyValueRow>
      <KeyValueRow label="Judge" variant="panel">{judge}</KeyValueRow>
    </KeyValue></CardContent></Card>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onShowAttempts}>Show the attempts</Button>
      {onRaceAgain && <Button variant="outline" size="sm" onClick={onRaceAgain}>Race again</Button>}
    </div>
  </div>
</PaneColumn>
