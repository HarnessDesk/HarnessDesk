import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { Button } from '../ui/button'
import { PageRecords } from './PageRecords'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
test('records resize by content width and row/action activation stays once-only', async () => {
  let width = 900, resize = () => {}
  const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 400))
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { resize = () => this.callback([{target,contentRect:{width}}] as ResizeObserverEntry[],this as unknown as ResizeObserver); resize() }
    disconnect() {}
  })
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  const open = vi.fn(), action = vi.fn()
  try {
    await act(async () => root.render(<PageRecords label="Team" columns={[{ id: 'time', label: 'Time', numeric: true }]}
      groups={[{ id: '/synthetic/project', label: 'project · 1', rows:[{ id:'team-demo', title:'Review the patch',
        description:'Waiting for review', compact:'Waiting for review · 3 minutes in this state',
        values:{ time:'3m' }, open, actions:<Button onClick={action}>Hide</Button> }] }]} />))
    expect(node.querySelector('[data-layout="table"]')).not.toBeNull()
    const row = node.querySelector<HTMLTableRowElement>('[data-team-row]')!
    act(() => row.querySelector<HTMLElement>('td')!.click()); expect(open).toHaveBeenCalledTimes(1)
    act(() => row.querySelector<HTMLButtonElement>('button')!.click()); expect(open).toHaveBeenCalledTimes(2)
    const hide = [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Hide')!
    act(() => hide.click()); expect(action).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledTimes(2)
    width = 420; await act(async () => resize())
    expect(node.querySelector('[data-layout="narrow"]')).not.toBeNull()
    expect(node.querySelector('[data-team-row]')!.textContent).toContain('Waiting for review · 3 minutes in this state')
  } finally { await act(async () => root.unmount()); node.remove(); box.mockRestore(); vi.unstubAllGlobals() }
})
