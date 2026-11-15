// All labels returned to the caller are fixed. Unmatched bodies are unknown,
// never asserted absent: heap snapshots may truncate or represent strings as ropes.
export function stableProtected(a,b) {
 const safe=s=>s&&s.enabled===true&&!s.pressureRunning&&!s.pressureDirty&&s.recovery===0&&s.eligibilityKnown===false&&s.visibleMounted===true&&s.visibleLoaded===true&&s.draftPresent===true&&s.draftLoaded===true&&s.pendingPresent===true&&s.pendingLoaded===true&&s.pendingActive===true&&s.pendingMounted===false&&s.pendingCloseSent===0&&s.pendingCloseResolved===0&&s.pendingCloseRejected===0&&s.knownMissing===0
 return !!safe(a)&&!!safe(b)&&JSON.stringify(a)===JSON.stringify(b)
}
export function analyzeHeap(s,expected) {
 const unavailable={status:'unavailable'}
 try {
  const nf=s.snapshot.meta.node_fields,ef=s.snapshot.meta.edge_fields,nw=nf.length,ew=ef.length
  const n=Object.fromEntries(nf.map((x,i)=>[x,i])),e=Object.fromEntries(ef.map((x,i)=>[x,i]))
  const types=s.snapshot.meta.node_types[n.type],edgeTypes=s.snapshot.meta.edge_types[e.type],nodes=s.nodes,edges=s.edges,names=s.strings
  if(!nw||!ew||nodes.length%nw||edges.length%ew||nodes.length/nw>8e6||edges.length/ew>32e6)return unavailable
  const look=new Map(expected.map((x,i)=>[x.needle,i])),found=new Map()
  for(let p=0;p<nodes.length;p+=nw){if(types[nodes[p+n.type]]!=='string')continue;const name=names[nodes[p+n.name]];if(typeof name!=='string')continue;const i=look.get(name.slice(0,expected[0]?.needle.length));if(i!==undefined&&!found.has(i))found.set(i,p/nw)}
  const loadedDetected=expected.reduce((a,x,i)=>a+(x.loaded&&found.has(i)?1:0),0)
  if(!loadedDetected)return unavailable
  const matchedBytes=(loaded)=>expected.reduce((total,x,i)=>total+(x.loaded===loaded&&found.has(i)?nodes[found.get(i)*nw+n.self_size]:0),0)
  const releasedIndices=expected.flatMap((x,i)=>!x.loaded&&found.has(i)?[i]:[]),releasedTotal=expected.filter(x=>!x.loaded).length
  const count=nodes.length/nw, edgeCount=edges.length/ew,head=new Int32Array(count).fill(-1),next=new Int32Array(edgeCount),source=new Int32Array(edgeCount)
  let ep=0,idx=0
  for(let p=0;p<nodes.length;p+=nw){for(let j=0;j<nodes[p+n.edge_count];j++,ep+=ew,idx++){const to=edges[ep+e.to_node]/nw;if(!Number.isInteger(to)||to<0||to>=count)return unavailable;source[idx]=p/nw;next[idx]=-1;if(edgeTypes[edges[ep+e.type]]!=='weak'){next[idx]=head[to];head[to]=idx}}}
  if(idx!==edgeCount)return unavailable
  const categories={appStore:0,react:0,observer:0,debugger:0,other:0,unknown:0}
  // Fixed bounded sample; category is an observed incoming-path hint, not a dominator.
  for(const i of releasedIndices.slice(0,8)){
   const queue=[[found.get(i),'other']],seen=new Set([found.get(i)]);let category='unknown',visited=0
   for(let q=0;q<queue.length&&visited<50000;q++,visited++){
    const [node,prior]=queue[q],name=names[nodes[node*nw+n.name]]||''
    let hint=prior
    if(name==='AppStore')hint='appStore'
    else if(/^(FiberNode|FiberRootNode)$/.test(name)&&hint==='other')hint='react'
    else if(/^__hd1545/.test(name)&&hint==='other')hint='observer'
    else if(/^(object group|Debugger)$/.test(name)&&hint==='other')hint='debugger'
    if(node===0){category=hint;break}
    for(let j=head[node];j!==-1;j=next[j]){const from=source[j];if(!seen.has(from)&&seen.size<50000){seen.add(from);queue.push([from,hint])}}
   }
   categories[category]++
  }
  return {status:'ok',loadedDetected,releasedDetected:releasedIndices.length,releasedUnknown:releasedTotal-releasedIndices.length,loadedMatchedStringSelfBytesLowerBound:matchedBytes(true),releasedMatchedStringSelfBytesLowerBound:matchedBytes(false),pathsSampled:Math.min(8,releasedIndices.length),pathCategories:categories}
 }catch{return unavailable}
}
