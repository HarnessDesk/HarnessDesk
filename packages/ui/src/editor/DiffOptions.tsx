import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuItem,
} from '../design'
import { MoreIcon } from '../components/Icons'
import { useOptionalStore } from '../state/context'
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from './diff-prefs'

const subscribeToNothing = () => () => {}
const defaults = () => DEFAULT_DIFF_PREFS
export const useDiffPreferences = () => {
  const store = useOptionalStore()
  const [local, setLocal] = useState(DEFAULT_DIFF_PREFS)
  const read = useCallback(() => store?.getSnapshot().diffPrefs ?? DEFAULT_DIFF_PREFS, [store])
  const saved = useSyncExternalStore(store?.subscribe ?? subscribeToNothing, read, defaults)
  const set = (patch: Partial<DiffPrefs>) => {
    if (store) store.setDiffPrefs(patch)
    else setLocal(current => ({ ...current, ...patch }))
  }
  return { prefs: store ? saved : local, set }
}

export const DiffOptions = ({ prefs, set, files }: {
  prefs: DiffPrefs
  set: (patch: Partial<DiffPrefs>) => void
  files?: { collapse: () => void; expand: () => void }
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Diff view options" title="Diff view options"><MoreIcon size={14} style={{ transform: 'rotate(90deg)' }} /></Button>} />
    <DropdownMenuContent align="end" aria-label="Diff view options">
      <DropdownMenuCheckboxItem checked={prefs.wrap} onCheckedChange={wrap => set({ wrap })}>Word wrap</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={prefs.highlightWords} onCheckedChange={highlightWords => set({ highlightWords })}>Highlight changed words</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={prefs.hideWhitespace} onCheckedChange={hideWhitespace => set({ hideWhitespace })}>Hide whitespace changes</DropdownMenuCheckboxItem>
      {files && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Collapse all files" onClick={files.collapse} />
        <DropdownMenuItem label="Expand all files" onClick={files.expand} />
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={prefs.showFiles} onCheckedChange={showFiles => set({ showFiles })}>Show files</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.groupByFolder} onCheckedChange={groupByFolder => set({ groupByFolder })}>Group files by folder</DropdownMenuCheckboxItem>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>
)
