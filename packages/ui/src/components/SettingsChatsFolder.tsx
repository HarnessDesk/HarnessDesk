import { useState } from 'react'
import { Button, MiddleTruncate, Note, Row, Rows } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { FolderPicker } from './FolderPicker'

/** One host-owned location; changing it does not move an existing conversation. */
export default function SettingsChatsFolder() {
  const store = useStore()
  const { chatsFolder, chatsFolderProblem } = useSnapshot()
  const [choosing, setChoosing] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async (path: string | null) => {
    setSaving(true)
    try { return await store.setChatsFolder(path) }
    finally { setSaving(false) }
  }
  return <>
    <Rows><Row title="Chats folder" desc={<MiddleTruncate>{chatsFolder}</MiddleTruncate>} control={<>
      <Button variant="secondary" size="sm" disabled={saving} onClick={() => { store.clearChatsFolderProblem(); setChoosing(true) }}>Change…</Button>
      <Button variant="secondary" size="sm" disabled={saving} onClick={() => { void save(null) }}>Reset</Button>
    </>} /></Rows>
    {!choosing && chatsFolderProblem && <Note tone="bad">{chatsFolderProblem}</Note>}
    {choosing && <FolderPicker title="Chats folder" problem={chatsFolderProblem} onChoose={save} onClose={() => { store.clearChatsFolderProblem(); setChoosing(false) }} />}
  </>
}
