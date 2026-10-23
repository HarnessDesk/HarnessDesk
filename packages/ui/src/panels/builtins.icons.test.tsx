import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { views } from './views'
import './builtins'

it('declares plain glyphs for view menus and tab strips',()=>{
 for(const view of views.all()) {
  if(!view.icon) continue
  const Icon=view.icon
  const host=document.createElement('div')
  host.innerHTML=renderToStaticMarkup(<Icon size={16}/>)
  expect(host.firstElementChild?.tagName.toLowerCase(),view.kind).toBe('svg')
  expect(host.querySelector('[data-slot="icon-tile"]'),view.kind).toBeNull()
 }
})
