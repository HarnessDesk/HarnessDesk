import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TeamsBoardCard } from './TeamsBoard'

it('keeps the Teams card element order, slots and description wiring', () => {
 const host=document.createElement('div')
 host.innerHTML=renderToStaticMarkup(<TeamsBoardCard id="one" title="Checkout" brief="Checkout work" summary="Choose a target" attention unread
  path={[{id:'review',label:'Review',state:'current'}]} faces={<span data-faces="seats">JD</span>} project="storefront" age="2h" open={()=>{}}/>)
 const button=host.querySelector('button')!
 expect(Object.fromEntries(Array.from(button.attributes).filter(attribute=>attribute.name!=='class' && attribute.name!=='aria-describedby').map(attribute=>[attribute.name,attribute.value]))).toEqual({
  type:'button','data-slot':'button','data-variant':'ghost',tabindex:'0','data-team-row':'one','aria-label':'Open Checkout','data-radius':'default','data-spacing':'compact',
 })
 expect(Array.from(button.children).map(child=>child.tagName)).toEqual(['SPAN','SPAN','DIV','SPAN'])
 expect(button.children[0]?.getAttribute('data-slot')).toBe('team-title')
 expect(button.children[0]?.getAttribute('title')).toBe('Checkout work')
 expect(button.children[1]?.getAttribute('data-slot')).toBe('team-detail')
 expect(button.children[1]?.getAttribute('title')).toBe('Choose a target')
 expect(button.children[2]?.getAttribute('data-slot')).toBe('segment-meter')
 expect(button.children[3]?.querySelector('[data-faces]')?.textContent).toBe('JD')
 expect(button.querySelector('[data-slot="team-age"]')?.textContent).toBe('2h')
 expect(button.getAttribute('aria-describedby')?.split(' ').map(id=>host.querySelector(`[id="${id}"]`)?.textContent)).toEqual(['Choose a target','storefront·2h'])
})
