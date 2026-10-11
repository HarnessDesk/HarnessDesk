import type { ReactNode } from 'react'
import { AppWindow, WindowPage } from './AppWindow'
import { LibrarySection } from './Library'
import { PluginsSection } from './PluginsSection'
/** Only the two managed families awaiting their own main-page migration. */
export const LegacyManagedPageWindow = ({page,onClose,leftColumn,libraryImport=false}: {
  readonly page:'library'|'plugins';readonly onClose:()=>void;readonly leftColumn:ReactNode;readonly libraryImport?:boolean
}) => <AppWindow owner="settings" label={page==='library'?'Library':'Plugins'} onBack={onClose} onClose={onClose} leftColumn={leftColumn}>
  <WindowPage>{page==='library'?<LibrarySection initialFlow={libraryImport?'import':null}/>:<PluginsSection/>}</WindowPage>
</AppWindow>
