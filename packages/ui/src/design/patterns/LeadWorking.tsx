import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Dot, Text } from './Settings'
import { TranscriptAssistantMessage } from './ConversationShell'
import styles from './LeadWorking.module.css'

/** One vocabulary for host-observed desk operations; unknown calls stay Thinking. */
export const LEAD_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  'lead/desk/summary': 'Reading the desk',
  'lead/chat/list': 'Finding chats',
  'lead/chat/read': 'Reading a chat',
  'lead/chat/start': 'Starting a chat',
  'lead/chat/send': 'Messaging a chat',
  'lead/chat/stop': 'Stopping a chat',
  'flow/catalog': 'Finding workflows',
  'flow/source': 'Reading a workflow',
  'flow/preview': 'Checking the plan',
  'flow/start-goal': 'Starting work',
  'flow/execution': 'Checking work',
  'flow/execution/stop': 'Stopping work',
  'flow/executions': 'Checking runs',
  'goal/list': 'Finding Teams',
  'goal/read': 'Reading a Team',
  'insight/goal': 'Checking a Team',
  'evidence/board': 'Reading the board',
  'evidence/seat': 'Checking a worker',
  'library/usage': 'Reading desk usage',
}

/** A pending reply's body, inside the same LeadTurn as its eventual text. The clock is a fact, never a live announcement. */
export const LeadWorking = ({ method, since, stopping = false, onStop }: {
  readonly method?: string | null; readonly since?: number; readonly stopping?: boolean; readonly onStop: () => void
}) => {
  const [started] = useState(() => Date.now()), [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const label = method && Object.hasOwn(LEAD_ACTIVITY_LABELS, method) ? LEAD_ACTIVITY_LABELS[method] : 'Thinking'
  return <TranscriptAssistantMessage><div data-slot="lead-working" className={styles.working}>
    <span className={styles.step} role="status"><Dot pulse /><Text role="prose" ink="secondary">{label}</Text></span>
    <Text role="meta" ink="muted" numeric>{`${Math.max(0, Math.floor((now - (since ?? started)) / 1000))}s`}</Text>
    <Button variant="link" size="inline-link" disabled={stopping} onClick={onStop}>Stop</Button>
  </div></TranscriptAssistantMessage>
}
