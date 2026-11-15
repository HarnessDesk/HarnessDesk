/** Find one enabled, rendered candidate; scroll it into view before a trusted CDP click. */
export function locateTarget(doc, selector, label, rowText = null) {
  const nodes=[...doc.querySelectorAll(selector)].filter(e=>
    ((e.textContent||'').includes(label)||(e.getAttribute('aria-label')||'').includes(label)) &&
    (rowText===null||((e.closest('[data-slot="list-row"]')?.innerText ?? e.closest('[data-slot="list-row"]')?.textContent ?? '').includes(rowText))))
  const eligible=nodes.filter(e=>{
    const r=e.getBoundingClientRect(), style=doc.defaultView.getComputedStyle(e)
    return r.width>0 && r.height>0 && !e.disabled && e.getAttribute('aria-disabled')!=='true' && style.visibility!=='hidden' && style.visibility!=='collapse'
  })
  const out={matches:nodes.length,eligible:eligible.length,inViewport:0,hits:0,scrolled:false,point:null}
  if(eligible.length!==1)return out
  const element=eligible[0],view=doc.defaultView
  const measure=()=>{
    const r=element.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2
    const inside=x>=0 && y>=0 && x<view.innerWidth && y<view.innerHeight
    const hit=inside && element.contains(doc.elementFromPoint(x,y))
    return {x,y,inside,hit}
  }
  let current=measure()
  if(!current.hit) {
    element.scrollIntoView({block:'nearest',inline:'nearest'})
    out.scrolled=true
    current=measure()
  }
  out.inViewport=Number(current.inside);out.hits=Number(current.hit)
  if(current.hit)out.point={x:current.x,y:current.y}
  return out
}
