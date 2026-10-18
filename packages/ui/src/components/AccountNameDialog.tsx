import { useRef, useState } from 'react'
import type { RuntimeInfo } from '@harnessdesk/protocol'
import { Button, Dialog, Field, Input } from '../design'
import { useSnapshot } from '../state/context'

/** One question before a credential home is made, shared by both ways to add it. */
export const AccountNameDialog = ({ info, adding, onAdd, onClose }: {
  info: RuntimeInfo
  adding: boolean
  onAdd: (name: string) => Promise<void>
  onClose: () => void
}) => {
  const snapshot = useSnapshot()
  const [name, setName] = useState('')
  const submitting = useRef(false)
  const agent = info.slot?.agent ?? info.id
  const original = snapshot.runtimes.find(entry => entry.id === agent) ?? info
  const used = new Set(snapshot.runtimes.filter(entry => (entry.slot?.agent ?? entry.id) === agent)
    .map(entry => entry.presentation.name))
  let number = 2
  while (used.has(`${original.presentation.name} ${number}`)) number += 1
  const placeholder = `${original.presentation.name} ${number}`

  const add = async () => {
    if (submitting.current || adding) return
    submitting.current = true
    try { await onAdd(name.trim()) }
    finally { submitting.current = false }
  }

  return (
    <Dialog title="Name this account" onClose={onClose} footer={<>
      <Button variant="default" disabled={adding} onClick={() => void add()}>{adding ? 'Adding…' : 'Add'}</Button>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
    </>}>
      <Field label="Name" hint={'Name it after the Google account you will sign in to, for example “Work” or dev@example.com.'}>
        {control => <Input {...control} value={name} placeholder={placeholder} maxLength={80} autoFocus
          onChange={event => setName(event.target.value)} />}
      </Field>
    </Dialog>
  )
}
