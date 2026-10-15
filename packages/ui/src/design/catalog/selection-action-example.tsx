import { useState } from 'react'
import { Button, SelectionAction } from '../index'

/** A selection action uses live specimen geometry rather than a fixed screen position. */
export const SelectionActionExample = () => {
  const [rect, setRect] = useState<DOMRect | null>(null)
  return <>
    <Button variant="outline" size="sm" onClick={event => setRect(event.currentTarget.getBoundingClientRect())}>Select file text</Button>
    {rect && <SelectionAction rect={rect} onAsk={() => setRect(null)} onDismiss={() => setRect(null)} />}
  </>
}
