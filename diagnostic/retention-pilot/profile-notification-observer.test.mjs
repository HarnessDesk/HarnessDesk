import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createNotificationObserver} from './profile-notification-observer.mjs'
const w=(n,extra={})=>({epoch:'private-epoch',generation:'private-generation',revision:n,sequence:n,...extra})
const p=(id,watermark)=>({runtime:'private-runtime',sessionId:id,watermark})
const snap=(id,watermark)=>({session:{runtime:'private-runtime',id},watermark})
const notice=(id,watermark)=>({method:'session/cache-invalidated',params:p(id,watermark)})

test('counts only the wait and emits no identifiers or watermark values',()=>{
 const o=createNotificationObserver((runtime,id)=>runtime==='private-runtime'&&id==='private-known')
 o.snapshotResult(p('private-known'),snap('private-known',w(1)))
 o.notification(notice('private-known',w(2)));o.begin()
 o.notification(notice('private-known',w(3)));o.notification(notice('private-known',w(5)))
 o.notification(notice('private-unknown',w(1)));o.notification(notice('private-known',w(6,{sequence:-1})))
 const x=o.end();assert.deepEqual(x,{total:4,known:3,unknown:1,contiguous:1,knownContiguous:1,unknownContiguous:0,ambiguous:1,noFloor:1,malformed:1,overflow:0})
 assert.doesNotMatch(JSON.stringify(x),/private/);assert.deepEqual(o.end(),null)
})

test('bounded floors, reconnect and stale snapshot responses fail conservative',()=>{
 const o=createNotificationObserver(()=>true,1);o.snapshotResult(p('private-one'),snap('private-one',w(5)));o.snapshotResult(p('private-two'),snap('private-two',w(1)))
 o.snapshotResult(p('private-one'),snap('private-one',w(4)));o.begin();o.notification(notice('private-one',w(6)));o.notification(notice('private-two',w(2)));o.reset();o.notification(notice('private-one',w(7)))
 assert.deepEqual(o.end(),{total:3,known:3,unknown:0,contiguous:0,knownContiguous:0,unknownContiguous:0,ambiguous:0,noFloor:3,malformed:0,overflow:1})
})

test('invalid notification and snapshot data cannot seed a floor',()=>{
 const o=createNotificationObserver(()=>{throw Error('private')});o.snapshotResult(p('private-one'),snap('private-other',w(1)));o.begin();o.notification(notice('private-one',w(2)));o.notification({method:'other'});o.notification({method:'session/cache-invalidated',params:{watermark:w(1)}})
 const x=o.end();assert.deepEqual(x,{total:2,known:0,unknown:2,contiguous:0,knownContiguous:0,unknownContiguous:0,ambiguous:0,noFloor:1,malformed:1,overflow:0});assert.doesNotMatch(JSON.stringify(x),/private/)
})

test('transport wrapper forwards once, preserves results, receiver and errors',async()=>{
 const {installNotificationObserver}=await import('./profile-notification-observer.mjs')
 const seen=[],receiver={},error=Error('private error'),body=snap('private-one',w(1))
 const transport={request(method){seen.push(['request',this,method]);if(method==='throw')throw error;return Promise.resolve(body)},handlers:{onNotification(n){seen.push(['notification',this,n.method])},onStatus(v){seen.push(['status',this,v])}}}
 const o=createNotificationObserver(()=>true);installNotificationObserver(transport,o)
 assert.equal(await transport.request('session/cache-snapshot',p('private-one')),body)
 o.begin();transport.handlers.onNotification(notice('private-one',w(2)));transport.handlers.onStatus('reconnecting');transport.handlers.onNotification(notice('private-one',w(3)))
 assert.throws(()=>transport.request('throw'),e=>e===error)
 assert.deepEqual(o.end(),{total:2,known:2,unknown:0,contiguous:1,knownContiguous:1,unknownContiguous:0,ambiguous:0,noFloor:1,malformed:0,overflow:0})
 assert.deepEqual(seen.map(x=>x[0]),['request','notification','status','notification','request']);assert.equal(seen[0][1],transport);assert.equal(seen[1][1],transport.handlers)
})

test('late snapshot cannot replace a watermark changed while its request was in flight',()=>{
 const o=createNotificationObserver(()=>true);const v=o.version();o.notification(notice('private-one',w(3)));o.snapshotResult(p('private-one'),snap('private-one',w(1)),v);o.begin();o.notification(notice('private-one',w(4)));assert.equal(o.end().noFloor,1)
})

test('wait sanitization drops nonfinite values and private fields',async()=>{
 const {sanitizeWaitObservation}=await import('./profile-notification-observer.mjs')
 const result=sanitizeWaitObservation({notifications:{total:1,known:1,knownContiguous:1,private:'secret'},rpc:{cacheSnapshot:{started:2,completed:Infinity,private:'secret'},prepareEviction:{started:3}},private:'secret'})
 assert.deepEqual(result,{notifications:{total:1,known:1,knownContiguous:1},rpc:{cacheSnapshot:{started:2},prepareEviction:{started:3}}});assert.doesNotMatch(JSON.stringify(result),/secret|private/)
})

test('observer faults never suppress notifications or change a request result',async()=>{
 const {installNotificationObserver}=await import('./profile-notification-observer.mjs')
 let sent=0,events=0,statuses=0;const response=Promise.resolve('ok')
 const transport={request(){return response},handlers:{onNotification(){sent++},onEvent(){events++},onStatus(){statuses++}}}
 const fail=()=>{throw Error('private')};installNotificationObserver(transport,{notification:fail,reset:fail,version:fail})
 assert.equal(transport.request('session/cache-snapshot',{}),response);transport.handlers.onNotification({method:'session/cache-invalidated'});transport.handlers.onEvent('x');transport.handlers.onStatus('closed')
 assert.deepEqual([sent,events,statuses],[1,1,1])
})

test('serialized factories used by renderer retain conservative classification',async()=>{
 const {createNotificationObserver,installNotificationObserver}=await import('./profile-notification-observer.mjs')
 const create=Function(`return (${createNotificationObserver.toString()})`)(),install=Function(`return (${installNotificationObserver.toString()})`)()
 const observer=create(()=>true),transport={request:async()=>snap('private-one',w(1)),handlers:{onNotification(){},onStatus(){},onEvent(){}}};install(transport,observer)
 await transport.request('session/cache-snapshot',p('private-one'));observer.begin();transport.handlers.onNotification(notice('private-one',w(2)));assert.equal(observer.end().knownContiguous,1)
})
