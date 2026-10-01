(() => {
  const selector = (el) => {
    const bits = [el.tagName.toLowerCase()]
    if (el.id) bits.push('#' + CSS.escape(el.id))
    if (typeof el.className === 'string' && el.className.trim()) bits.push('.' + el.className.trim().split(/\s+/).slice(0, 3).map(CSS.escape).join('.'))
    if (el.getAttribute('aria-label')) bits.push(`[aria-label="${el.getAttribute('aria-label').replaceAll('"', '\\"')}"]`)
    return bits.join('')
  }
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const effectiveBox = (el) => {
    const r = el.getBoundingClientRect()
    let box = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) }
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a), ar = a.getBoundingClientRect()
      if (/(hidden|clip|scroll|auto)/.test(s.overflowX)) { box.left = Math.max(box.left, ar.left); box.right = Math.min(box.right, ar.right) }
      if (/(hidden|clip|scroll|auto)/.test(s.overflowY)) { box.top = Math.max(box.top, ar.top); box.bottom = Math.min(box.bottom, ar.bottom) }
    }
    return box
  }
  const visible = (el) => {
    const r = effectiveBox(el), s = getComputedStyle(el)
    return r.right - r.left > 1 && r.bottom - r.top > 1 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0
  }
  const box = (el) => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, right:r.right, bottom:r.bottom, left:r.left } }
  const activeLayer = [...document.querySelectorAll('[class*="layer"]:not([data-hidden])')].find(visible)
  const root = activeLayer?.closest('[data-slot="dock-panel"]') || activeLayer?.closest('[class*="panel"]') || activeLayer?.closest('[class*="main"]') || activeLayer || document.querySelector('main') || document.body
  const hasOwnText = (el) => [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  const nodes = [root, ...root.querySelectorAll('*')].filter((el) => hasOwnText(el) && visible(el))
  const pairs = []
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j]
    if (a.contains(b) || b.contains(a)) continue
    const x = effectiveBox(a), y = effectiveBox(b)
    const w = Math.min(x.right, y.right) - Math.max(x.left, y.left)
    const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
    if (w > 1 && h > 1) pairs.push({ a:{selector:selector(a), text:text(a).slice(0,180), rect:box(a), visibleRect:x}, b:{selector:selector(b), text:text(b).slice(0,180), rect:box(b), visibleRect:y}, intersection:{width:w,height:h} })
  }
  const clipping = nodes.filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis').map((el) => ({selector:selector(el), text:text(el).slice(0,180), rect:box(el), scrollWidth:el.scrollWidth, clientWidth:el.clientWidth, textOverflow:getComputedStyle(el).textOverflow}))
  const sentenceEllipses = nodes.filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis' && /[.!?]/.test(text(el)) && text(el).split(' ').length >= 5).map((el) => ({selector:selector(el), text:text(el).slice(0,180), rect:box(el), scrollWidth:el.scrollWidth, clientWidth:el.clientWidth}))
  const textEvidence = nodes.filter(el => /^(Thinking|Turn 1|3\.5s|3.5s measured|Command|Trajectory|38%|1 out)$/.test(text(el))).map(el => ({selector:selector(el), text:text(el), rect:box(el)}))
  const headerControls = [...root.querySelectorAll('button')].filter(visible).map(el => ({selector:selector(el), text:text(el), ariaLabel:el.getAttribute('aria-label'), title:el.title, rect:box(el)}))
  const snapshot = window.__hdStore?.getSnapshot?.()
  const session = snapshot?.activeSessionKey ? snapshot.sessions?.get(snapshot.activeSessionKey) : null
  const turns = (session?.turns ?? []).map(turn => ({status:turn.status, durationMs:turn.durationMs, items:turn.items.map(item => ({type:item.type, durationMs:'durationMs' in item ? item.durationMs ?? null : null}))}))
  return { title:document.title, viewport:{width:innerWidth,height:innerHeight}, root:selector(root), overlapPairs:pairs, hardClipping:clipping, sentenceEllipses, textEvidence, headerControls, timing:{turns, itemDurationSum:turns.reduce((sum,turn)=>sum+turn.items.reduce((n,item)=>n+(typeof item.durationMs==='number'&&item.durationMs>0?item.durationMs:0),0),0)} }
})
