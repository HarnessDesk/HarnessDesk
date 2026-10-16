import { useMemo, useRef, useState } from 'react'
import { Button, PatchHeader, Text, ToolbarGap } from '../design'
import { ChevronIcon } from '../components/Icons'
import { scriptedScrollBehavior } from '../lib/scripted-scroll'
import { countChanges, type FileDiff } from './diff'
import { DiffOptions, useDiffPreferences } from './DiffOptions'
import { DiffView } from './DiffView'
import type { DiffPrefs } from './diff-prefs'
import styles from './DiffFilesView.module.css'

/** The same diff reader with per-file headings and navigation for an aggregate patch. */
export const DiffFilesView = ({ files, wrap, preferences }: { files: readonly FileDiff[]; wrap?: boolean | undefined; preferences?: DiffPrefs | undefined }) => {
  const { prefs: saved, set } = useDiffPreferences()
  const prefs = preferences ?? (wrap === undefined ? saved : { ...saved, wrap })
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const sections = useRef(new Map<string, HTMLDivElement>())
  const groups = useMemo(() => {
    const grouped = new Map<string, FileDiff[]>()
    for (const file of files) {
      const folder = prefs.groupByFolder ? file.path.slice(0, file.path.lastIndexOf('/') + 1) || '.' : ''
      const group = grouped.get(folder) ?? []
      group.push(file); grouped.set(folder, group)
    }
    return [...grouped]
  }, [files, prefs.groupByFolder])
  const toggle = (path: string) => setCollapsed(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })
  const reveal = (path: string) => {
    setCollapsed(current => new Set([...current].filter(value => value !== path)))
    requestAnimationFrame(() => sections.current.get(path)?.scrollIntoView({ block: 'start', behavior: scriptedScrollBehavior() }))
  }
  return <div className={styles.files}>
    <div className={styles.toolbar}>
      <Text role="meta">{files.length} {files.length === 1 ? 'file' : 'files'}</Text><ToolbarGap />
      <DiffOptions prefs={prefs} set={set} {...(files.length > 1 ? { files: {
        collapse: () => setCollapsed(new Set(files.map(file => file.path))), expand: () => setCollapsed(new Set()),
      } } : {})} />
    </div>
    {files.length > 1 && prefs.showFiles && <nav aria-label="Changed files" className={styles.list}>
      {groups.map(([folder, entries]) => <div key={folder}>
        {folder && <Text role="meta" data-diff-folder="">{folder}</Text>}
        {entries.map(file => <Button key={file.path} variant="ghost" size="sm" className={styles.path} onClick={() => reveal(file.path)}>{file.path || 'Patch'}</Button>)}
      </div>)}
    </nav>}
    {groups.flatMap(([, entries]) => entries).map((file, index) => {
      const count = countChanges(file.diff), open = !collapsed.has(file.path)
      return <div key={`${file.path}-${index}`} ref={element => { if (element) sections.current.set(file.path, element); else sections.current.delete(file.path) }}>
        <PatchHeader>
          <Button variant="ghost" size="sm" className={styles.path} onClick={() => toggle(file.path)} aria-expanded={open} title={file.path}>
            <ChevronIcon size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />{file.path || 'Patch'}
          </Button>
          <ToolbarGap /><span className={styles.counts}><span className={styles.add}>+{count.added}</span> <span className={styles.remove}>−{count.removed}</span></span>
        </PatchHeader>
        {open && <DiffView diff={file.diff} preferences={prefs} options={false} />}
      </div>
    })}
  </div>
}
