/** Bounded structural counts only: no names, paths, text, coordinates, or DOM dumps. */
export function flowVisibility(doc) {
  const rows=[...doc.querySelectorAll('[data-region="team-row"]')]
  const buttons=[...doc.querySelectorAll('[data-region="team-row"] button[aria-label^="Actions for"]')]
  const out={dialogs:Math.min(100,doc.querySelectorAll('[role="dialog"]').length),teamRows:Math.min(100,rows.length),actionButtons:Math.min(100,buttons.length),zeroRect:0,hiddenStyle:0,inert:0,ariaHidden:0}
  for(const e of buttons.slice(0,100)) {
    const r=e.getBoundingClientRect()
    if(r.width<=0 || r.height<=0)out.zeroRect++
    let hidden=false,inert=false,aria=false
    for(let n=e;n;n=n.parentElement){
      const s=doc.defaultView.getComputedStyle(n)
      if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')hidden=true
      if(n.hasAttribute('inert'))inert=true
      if(n.getAttribute('aria-hidden')==='true')aria=true
    }
    if(hidden)out.hiddenStyle++
    if(inert)out.inert++
    if(aria)out.ariaHidden++
  }
  return out
}

export async function closeHistoryDialog({cdp,click,waitFor,result}) {
  const observe=async()=>{
    const value=await cdp.json(`(${flowVisibility.toString()})(document)`)
    if(!value || Object.keys(value).sort().join(',')!=='actionButtons,ariaHidden,dialogs,hiddenStyle,inert,teamRows,zeroRect' ||
      Object.values(value).some(n=>!Number.isInteger(n)||n<0||n>100))throw Error('visibility observation invalid')
    return value
  }
  result.phase='flow_close_history'
  result.visibility={beforeClose:await observe()}
  await waitFor('one Triggers dialog',()=>cdp.eval("document.querySelectorAll('[role=dialog]').length===1 && document.querySelector('[role=dialog]').innerText.includes('Triggers')"),10000)
  await click('[role="dialog"] [data-slot="dialog-footer"] button','Close',null,'flow_close_history')
  await waitFor('Triggers closed',()=>cdp.eval("document.querySelectorAll('[role=dialog]').length===0"),10000)
  result.visibility.afterClose=await observe()
  result.checks.flowHistoryClosed=true
}
