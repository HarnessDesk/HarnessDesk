import { expect, it } from 'vitest'

it('gives text ranges the same empty geometry as jsdom elements',()=>{
 const element=document.createElement('span')
 element.textContent='A line to measure'
 document.body.append(element)
 try {
  const range=document.createRange()
  range.selectNodeContents(element)
  expect(typeof range.getClientRects).toBe('function')
  expect([...range.getClientRects()]).toEqual([...element.getClientRects()])
  expect(range.getClientRects().item(0)).toBeNull()
  const rect=range.getBoundingClientRect()
  const elementRect=element.getBoundingClientRect()
  for(const key of ['x','y','width','height','top','right','bottom','left'] as const)expect(rect[key]).toBe(elementRect[key])
 } finally {element.remove()}
})
