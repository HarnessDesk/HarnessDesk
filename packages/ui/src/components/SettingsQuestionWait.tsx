import { useEffect, useRef, useState } from 'react'

import type { QuestionWait } from '@harnessdesk/protocol'

import { RowChoice, Rows, Section } from '../design'
import { useStore } from '../state/context'

/**
 * The choices, shortest first. No row carries a second line: a length of
 * time says itself, and what happens when it runs out is the same sentence
 * for every row, so the section says it once.
 */
export const QUESTION_WAIT_CHOICES: readonly { readonly value: QuestionWait; readonly title: string }[] = [
  { value: 'now', title: 'Not at all — stop right away' },
  { value: '1m', title: 'A minute' },
  { value: '5m', title: 'Five minutes' },
  { value: '1h', title: 'An hour' },
  { value: 'back', title: 'Until I’m back' },
]

/**
 * How long an agent's question waits when nobody is here — on a run a
 * trigger started — before its run stops for you. A machine setting; a run
 * you started is never timed. Answering after the wait still carries the
 * work on, so a short wait loses nothing but the agent's time.
 */
export const QuestionWaitSection = () => {
  const store = useStore()
  const saving = useRef(false)
  const [wait, setWait] = useState<QuestionWait | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setWait(null)
    void store.loadQuestionWait().then((next) => {
      if (live) setWait(next)
    })
    return () => { live = false }
  }, [store])

  const choose = async (next: QuestionWait): Promise<void> => {
    if (wait === null || saving.current || next === wait) return
    saving.current = true
    const before = wait
    setWait(next)
    setBusy(true)
    try {
      // A write that did not land puts the choice back: a setting shown as kept that was not is the one lie here.
      if (!await store.setQuestionWait(next)) setWait(before)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const disabled = wait === null || busy
  return (
    <Section
      title="When nobody is here, an agent’s question waits"
      description="In a Goal a trigger opened. When the wait ends, its run stops for you, and answering later still carries the work on."
    >
      <Rows role="radiogroup" aria-label="How long an agent’s question waits when nobody is here">
        {QUESTION_WAIT_CHOICES.map((choice) => (
          <RowChoice
            key={choice.value}
            title={choice.title}
            selected={wait === choice.value}
            disabled={disabled}
            onClick={() => void choose(choice.value)}
          />
        ))}
      </Rows>
    </Section>
  )
}
