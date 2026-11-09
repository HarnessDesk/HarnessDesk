import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Dot, Text } from './Settings'
import { TurnItem } from './TurnWork'
import { TranscriptAssistantMessage } from './ConversationShell'
import styles from './LeadWorking.module.css'

/** A pending reply's body, inside the same LeadTurn as its eventual text. The clock is a fact, never a live announcement. */
export const LeadWorking = ({ label = 'Thinking', since, stopping = false, onStop }: {
  readonly label?: string; readonly since?: number; readonly stopping?: boolean; readonly onStop: () => void
}) => {
  const [started] = useState(() => Date.now()), [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  return <TurnItem><TranscriptAssistantMessage><div data-slot="lead-working" className={styles.working}>
    <span className={styles.step} role="status"><Dot pulse /><Text role="prose" ink="secondary">{label}</Text></span>
    <Text role="meta" ink="muted" numeric>{`${Math.max(0, Math.floor((now - (since ?? started)) / 1000))}s`}</Text>
    <Button variant="link" size="inline-link" disabled={stopping} onClick={onStop}>Stop</Button>
  </div></TranscriptAssistantMessage></TurnItem>
}
