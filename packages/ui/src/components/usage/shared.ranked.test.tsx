;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Ranked } from './shared'

it('labels the ranked data and draws a dash for an unavailable share in both forms', () => {
 const ledger={currency:'USD',rows:[{key:'unpriced',label:'Unpriced model',runtime:null,cost:null,tokens:null,hasUnpriced:true}],provenance:'listPrice'} as never
 const container=document.createElement('div');const root=createRoot(container)
 for(const compact of [false,true]) {
  act(()=>root.render(<Ranked ledger={ledger} wideLedger={null} pivot="model" range={30} now={1} byId={new Map()} tintOf={()=>'blue'} compact={compact} />))
  expect([...container.querySelectorAll('th')].map(n=>n.textContent)).toEqual(compact?['Name','Share']:['Name','Share','Tokens','Cost'])
  expect(container.querySelector('tbody tr')?.children[1]?.textContent).toBe('—')
 }
 act(()=>root.unmount())
})
