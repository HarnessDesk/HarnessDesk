import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { previewStore } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { LegacyManagedPageWindow } from './LegacyManagedPageWindow'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
it('the actual compatibility host delivers import intent once and repeated Library/Plugins mounts remain reachable',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=previewStore()
  const render=(page:'library'|'plugins',libraryImport=false)=>act(async()=>root.render(<StoreProvider store={store}><TopBarProvider><ShellHostsProvider><LegacyManagedPageWindow key={page} page={page} libraryImport={libraryImport} leftColumn={<div>Normal column</div>} onClose={()=>{}}/><ShellOutlets activeOwner="settings"/></ShellHostsProvider></TopBarProvider></StoreProvider>))
  try{await render('library',true)
    expect(document.querySelector('[data-slot="dialog-head"]')?.textContent).toContain('Import')
    const cancel=[...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')].find(node=>node.textContent==='Cancel')!;await act(async()=>cancel.click())
    expect(document.querySelector('[data-slot="dialog-head"]')).toBeNull()
    await render('plugins');expect(document.body.textContent).toContain('Installed')
    await render('library');expect(document.querySelector('[data-slot="dialog-head"]')).toBeNull();expect(document.body.textContent).toContain('Library')
  }finally{act(()=>root.unmount());box.remove()}
})
