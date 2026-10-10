import { useEffect, useState } from 'react'
import { Banner } from '../design'
import { useSnapshot } from '../state/context'

/** Startup gets five quiet seconds; a dropped link is immediate and self-clearing. */
export const ConnectionNotice = () => {
  const { status } = useSnapshot()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (status !== 'connecting') return
    const timer = window.setTimeout(() => setSlow(true), 5000)
    return () => window.clearTimeout(timer)
  }, [status])
  if (status === 'open' || status === 'connecting' && !slow) return null
  const title = { connecting: 'Connecting to HarnessDesk…', reconnecting: 'Reconnecting to HarnessDesk.', closed: 'Disconnected from HarnessDesk.' }[status]
  return <Banner role="status" tone="warning" title={title}>Sessions keep running; this window will catch up.</Banner>
}
