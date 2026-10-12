import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { sessionKey } from '@harnessdesk/protocol'
import { StoreProvider, PaneProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ChangesView } from './Details'

it('Changes hands Revise to its owning composer with an acknowledgement after tool focus', async () => {
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  const key=sessionKey('fixture','one'), focusPane=vi.fn()
  const snapshot={...emptySnapshot(),workspace:{path:'/fixture',name:'Fixture',lastOpenedAt:1}}
  const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,focusPane,notice:vi.fn(),transport:{request:vi.fn(async (method:string)=>method==='git/status'
    ? {root:'/fixture',branch:'main',ahead:0,behind:0,files:[{path:'a.ts',status:'modified',staged:false}]}
    : {diff:'@@ -1 +1 @@\n-old\n+new'})}} as unknown as AppStore
  const delivered: unknown[]=[]
  const receive=(event:Event) => {
    const request=(event as CustomEvent).detail;delivered.push(request)
    request.onReceived?.()
  }
  window.addEventListener('harnessdesk:compose',receive)
  try {
    await act(async()=>root.render(<StoreProvider store={store}><PaneProvider scope={{paneId:'owner',keyboardMountId:'tool',view:{kind:'conversation',session:key},sessionKey:key}}><ChangesView /></PaneProvider></StoreProvider>))
    const file=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.includes('a.ts'))!
    expect(file).toBeTruthy();await act(async()=>file.click())
    const revise=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Revise…')!
    await act(async()=>revise.click())
    expect(focusPane).toHaveBeenCalledWith('owner')
    expect(delivered).toEqual([expect.objectContaining({paneId:'owner',text:'Please revise your change to a.ts: ',onReceived:expect.any(Function)})])
  } finally {window.removeEventListener('harnessdesk:compose',receive);await act(async()=>root.unmount());host.remove()}
})
