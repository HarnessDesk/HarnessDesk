import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { PageControls } from './PageControls'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
test('page controls keep labels, disabled options and choice callbacks', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), change = vi.fn()
  try {
    await act(async () => root.render(<PageControls choices={[{id:'scope',title:'Agent scope',value:'all',options:[{value:'all',label:'All agents'},{value:'pending',label:'Pending',disabled:true},{value:'local',label:'Local'}],change}]} />))
    const select = host.querySelector('select')!
    expect(select.getAttribute('aria-label')).toBe('Agent scope')
    expect(select.querySelector('option[value="pending"]')?.hasAttribute('disabled')).toBe(true)
    await act(async () => { select.value='local'; select.dispatchEvent(new Event('change',{bubbles:true})) })
    expect(change).toHaveBeenCalledWith('local')
  } finally { await act(async () => root.unmount()); host.remove() }
})
