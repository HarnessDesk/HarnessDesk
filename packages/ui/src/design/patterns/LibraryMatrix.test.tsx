import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LibraryMatrix } from './LibraryMatrix'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps availability truth, disclosure, complete footer values and expanded content in the data block', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), open = vi.fn(), install = vi.fn()
  try {
    await act(async () => root.render(<LibraryMatrix columns={[{id:'one',label:'First Agent',help:'Measured catalogue'}]}
      rows={[{id:'sample',name:'sample-skill',description:'A long definition',open,
        cells:[{id:'one',state:'unscanned',problem:true,label:'Not read',help:'Not confirmed by this build',mark:'—',run:install}],
        expanded:<p>One copy on disk</p>}]}
      footer={{label:'Advertised each turn',title:'Filtered rows',values:{one:1250}}}
      fired={{label:'Fired here, ever',title:'Stored conversations',values:{one:1}}} />))
    expect(box.querySelector('[data-slot="library-matrix"]')).not.toBeNull()
    expect(box.querySelector('[data-library-state="unscanned"]')?.getAttribute('title')).toBe('Not confirmed by this build')
    expect(box.querySelector('[data-library-state="unscanned"]')?.hasAttribute('data-problem')).toBe(true)
    const disclosure = box.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!
    await act(async () => disclosure.click()); expect(open).toHaveBeenCalledOnce()
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="Not read"]')!.click()); expect(install).toHaveBeenCalledOnce()
    expect(box.querySelector('td[colspan="2"]')?.textContent).toBe('One copy on disk')
    expect(box.querySelector('tfoot')?.textContent).toContain('≈1,250 tok')
    expect(box.querySelector('tfoot')?.textContent).toContain('1 of 1')
  } finally { act(() => root.unmount()); box.remove() }
})
