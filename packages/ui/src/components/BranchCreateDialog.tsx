import { useState } from 'react'

import { ActionError, Button, Dialog, Field, FormStack, Input } from '../design'
import { useStore } from '../state/context'

export const BranchCreateDialog = ({ root, onDone, onClose }: { root: string; onDone: () => void; onClose: () => void }) => {
  const store = useStore()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (await store.checkoutBranch(root, name.trim(), { create: true })) { onDone(); onClose() }
      else setError(`Could not create ${name.trim()}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  return <Dialog title="Create and checkout new branch" onClose={onClose} footer={<>
    <Button disabled={busy || !name.trim()} onClick={() => void submit()}>Create</Button>
    <Button variant="quiet" disabled={busy} onClick={onClose}>Keep current branch</Button>
  </>}>
    <FormStack><Field label="Branch name">{control => <Input {...control} value={name} placeholder="feature/storefront-search" onChange={event => setName(event.target.value)} autoFocus spellCheck={false} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); void submit() }
    }} />}</Field></FormStack>
    {error && <ActionError>{error}</ActionError>}
  </Dialog>
}
