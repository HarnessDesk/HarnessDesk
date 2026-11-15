// Evaluated inside the renderer. Check the same protected sentinels as sample()
// without serializing all workload bodies while pressure is still active.
export const quietPrecheck = (store, sent) => {
 const snap=store.getSnapshot(),stats=store.transcriptCacheStats()
 const panes=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...panes(n.first),...panes(n.second)]:[]
 for(const key of Object.values(sent))if(!snap.sessions.get(key)?.itemsLoaded)throw Error('sentinel not loaded')
 const mounted=panes(snap.layout.root).some(p=>p.view?.kind==='conversation'&&p.view.session===sent.visible)
 if(!mounted||!store.drafts.live(sent.draft)||!snap.approvals.some(a=>a.key===sent.pending)||!snap.sessions.get(sent.pending)?.turns.some(t=>t.status==='inProgress'))throw Error('sentinel protection missing')
 return {enabled:stats.enabled,pressureRunning:stats.pressureRunning,pressureDirty:stats.pressureDirty}
}
const busy = state => !state.enabled || state.pressureRunning || state.pressureDirty
const increment = (counts,key) => { counts[key]=Math.min(10000,counts[key]+1) }
// The precheck is only a hint: both original full samples still decide success.
export const quiescenceStep = async (withPrecheck,precheck,sample,barrier,counts) => {
 if(withPrecheck){increment(counts,'prechecks');const gate=await precheck();if(busy(gate)){increment(counts,'busyPrechecks');return false}}
 if(withPrecheck)increment(counts,'fullSamples')
 const first=await sample();if(busy(first))return false
 await barrier()
 if(withPrecheck)increment(counts,'fullSamples')
 const second=await sample()
 return JSON.stringify(first)===JSON.stringify(second)?second:false
}
export const sanitizeProbeCounts = value => {
 const result={}
 for(const key of ['prechecks','busyPrechecks','fullSamples']){
  const item=value?.[key]
  if(!Number.isSafeInteger(item)||item<0||item>10000)return null
  result[key]=item
 }
 return result.busyPrechecks<=result.prechecks?result:null
}
