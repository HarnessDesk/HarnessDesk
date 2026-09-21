import { useCallback, useEffect, useRef, useState } from 'react'
import type { GoalReceipt } from '@harnessdesk/protocol'

import { useStore } from '../state/context'
import { InsightCost } from './InsightCost'

/**
 * The receipt remains an immutable value.  This sibling owns the volatile
 * read, so refreshing accounting can neither replace nor amend receipt data.
 */
export const GoalReceiptCost = ({ receipt }: { readonly receipt: GoalReceipt }) => {
  const store = useStore()
  const [report, setReport] = useState<import('@harnessdesk/protocol').InsightReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  const load = useCallback(() => {
    if (typeof store.readGoalInsight !== 'function') return
    const current = ++generation.current
    setLoading(true)
    setProblem(null)
    void store.readGoalInsight(receipt.goal).then(
      (next) => {
        if (generation.current !== current) return
        setReport(next)
        setLoading(false)
      },
      (error: unknown) => {
        if (generation.current !== current) return
        setProblem(error instanceof Error ? error.message : 'The recorded sources did not respond.')
        setLoading(false)
      },
    )
  }, [receipt.goal, store])

  useEffect(() => {
    load()
    return () => { generation.current += 1 }
  }, [load])

  return <InsightCost report={report} loading={loading} problem={problem} onRefresh={load} onSeat={() => {}} onSession={() => {}} onMessage={() => {}} />
}
