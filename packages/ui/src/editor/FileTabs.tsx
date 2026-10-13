import { DockPanelTabs, DockPanelTab } from '../design'
import { sanitizeText } from '../lib/sanitize'
import type { EditorTab } from './state'
import styles from './FileTabs.module.css'

/** Document tabs use the design system's keyboard navigation and separate close target. */
export const FileTabs = ({ tabs, active, preview, dirty, onSelect, onKeep, onClose }: {
  readonly tabs: readonly EditorTab[]
  readonly active: string | null
  readonly preview: string | null
  readonly dirty: ReadonlySet<string>
  readonly onSelect: (path: string) => void
  readonly onKeep: (path: string) => void
  readonly onClose: (path: string) => void
}) => <div className={styles.strip} data-slot="file-tabs">
  <DockPanelTabs label="Open files" value={active} onValueChange={onSelect}
    className="h-(--hd-file-tabs-h) group-data-[orientation=horizontal]/tabs:h-(--hd-file-tabs-h) gap-0 bg-(--hd-sidebar)">
    {tabs.map(tab => {
      const label = sanitizeText(tab.path.split('/').pop() ?? tab.path), unsaved = dirty.has(tab.path)
      return <DockPanelTab key={tab.path} value={tab.path} label={label} title={sanitizeText(tab.path)}
        aria-label={unsaved ? `${label}, unsaved` : label} unsaved={unsaved} closeOnHover
        data-preview={preview === tab.path ? '' : undefined}
        onDoubleClick={() => onKeep(tab.path)} onClose={() => onClose(tab.path)}
        className="group-data-[orientation=horizontal]/tabs:h-(--hd-file-tabs-h) rounded-none border-t-(length:--hd-space-0-5) border-t-transparent pr-[calc(var(--hd-icon-target-sm)+var(--hd-space-2))] group-[:is([data-variant=line],[data-variant=section])]/tabs-list:data-active:bg-(--hd-background) group-[:is([data-variant=line],[data-variant=section])]/tabs-list:data-active:after:opacity-0 data-active:border-t-(--hd-accent) data-preview:italic" />
    })}
  </DockPanelTabs>
</div>
