import type { ReactNode } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { Text } from './Settings'

export interface StatusFact {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly run?: () => void
  readonly disabled?: boolean
}
/** The app's readings share one window-wide foot, below every retained region. */
export const StatusBar = ({ usage, facts, terminal }: { usage: ReactNode; facts: readonly StatusFact[]; terminal: ReactNode }) => <Bar as="footer" height="status" rule="top" paintedRule
  data-slot="status-bar" className="hd-no-drag min-w-0">
  {usage}{facts.map(one => one.run ? <Button key={one.id} variant="quiet" size="xs" title={one.detail}
    disabled={one.disabled} onClick={one.run}>{one.label}</Button> : <Text key={one.id} role="meta" title={one.detail}>{one.label}</Text>)}
  <span className="min-w-0 flex-1" />{terminal}
</Bar>
