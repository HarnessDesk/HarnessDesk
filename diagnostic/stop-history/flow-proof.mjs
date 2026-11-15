import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function seedProtectedFlow({ source, root, deskHome, project, env }) {
  const child = spawnSync(process.execPath, [join(source, 'diagnostic/stop-history/seed-child.mjs'), source, root, deskHome, project],
    { env, timeout: 30000, maxBuffer: 16384, encoding: 'buffer' })
  if (child.status !== 0 || child.signal || child.error || child.stdout.length > 16384 || child.stderr.length > 16384) throw Error('seed failed')
  const receipt = join(root, 'flow-seed-receipt.json'), stat = lstatSync(receipt)
  const rel = relative(realpathSync(root), realpathSync(receipt))
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw Error('seed receipt invalid')
  const data = JSON.parse(readFileSync(receipt, 'utf8'))
  if (Object.keys(data).sort().join(',') !== 'goal,run' || typeof data.run !== 'string' || !data.run || typeof data.goal !== 'string' || !data.goal) throw Error('seed receipt invalid')
  const { executionOf } = await import(pathToFileURL(join(source, 'packages/server/dist/src/flow-recovery.js')).href)
  const read = () => executionOf(JSON.parse(readFileSync(join(deskHome, 'flows-v2', `${encodeURIComponent(data.run)}.json`), 'utf8')))
  const run = read()
  if (run.id !== data.run || run.goal !== data.goal || run.state !== 'stopped' || !run.mentionStopOnce) throw Error('seed record invalid')
  return { ...data, read }
}

export async function captureSafely(frame, result) {
  try { return await frame() } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : ''
    const reason = message === 'privacy audit failed' || message === 'frame changed or privacy audit failed' ? 'privacy_refused'
      : message === 'invalid frame' || message === 'invalid frame dimensions' ? 'frame_invalid' : 'frame_unavailable'
    result.frameReasons ??= []
    if (result.frameReasons.length < 5) result.frameReasons.push(reason)
    return null
  }
}

export async function exerciseProtectedFlow({ cdp, click, waitFor, result, flow, frame }) {
  const runId = JSON.stringify(flow.run)
  const projection = `(()=>{const r=window.__hdStore?.getSnapshot().flowExecutions.get(${runId});return r ? {stopped:r.state==='stopped',canStop:r.canStop===true,absent:!Object.hasOwn(r,'canStop')} : null})()`
  await cdp.eval(`(()=>{const t=window.__hdStore.transport,original=t.request;window.__hdFlowStopCount=0;t.request=function(method,...args){if(method==='flow/execution/stop')window.__hdFlowStopCount++;return Reflect.apply(original,this,[method,...args])}})()`)
  result.phase='flow_team_menu'
  await click('[data-region="team-row"] button[aria-label^="Actions for"]','Review the synthetic change',null,'flow_team_menu')
  await waitFor('protected projection', async () => { const v=await cdp.json(projection); return v?.stopped && v.canStop }, 30000)
  const menuFrame=await frame()
  await click('[role="menuitem"]','Stop run…',null,'flow_team_stop')
  await waitFor('ended confirmation',()=>cdp.eval("document.querySelectorAll('[role=alertdialog]').length===1 && document.querySelector('[role=alertdialog]').innerText.includes('Finish stopping this Run?')"),10000)
  const confirmFrame=await frame()
  await click('[role="alertdialog"] button[data-slot="button"]','Close',null,'flow_cancel')
  if(await cdp.eval('window.__hdFlowStopCount')!==0 || !flow.read().mentionStopOnce) throw Error('cancel had an effect')
  result.checks.flowCancel=true
  result.phase='flow_run_view'
  await click('[data-region="team-row"] button[aria-label="Room Review the synthetic change"]','Review the synthetic change',null,'flow_open_team')
  await click('[role="tablist"][aria-label="Team views"] [role="tab"][data-team-page="overview"]','Work',null,'flow_open_run')
  await waitFor('Team Work view',()=>cdp.eval("document.querySelectorAll('[role=\"tablist\"][aria-label=\"Team views\"] [role=\"tab\"][data-team-page=\"overview\"][aria-selected=\"true\"]').length===1 && document.querySelectorAll('[data-slot=\"run-workspace\"]').length===1"),10000)
  await click('[data-slot="page-options"] button','Stop run…',null,'flow_run_stop')
  await waitFor('ended confirmation',()=>cdp.eval("document.querySelectorAll('[role=alertdialog]').length===1 && document.querySelector('[role=alertdialog]').innerText.includes('Finish stopping this Run?')"),10000)
  await click('[role="alertdialog"] button[data-slot="button"]','Stop run',null,'flow_confirm')
  result.phase='flow_durable'
  await waitFor('manual cleanup durable',()=>{const r=flow.read();return r.id===flow.run && r.state==='stopped' && r.version===2 && !Object.hasOwn(r,'mentionStopOnce')},30000)
  await waitFor('ordinary stopped projection',async()=>{const v=await cdp.json(projection);return v?.stopped && v.absent},30000)
  if(await cdp.eval('window.__hdFlowStopCount')!==1)throw Error('stop request count mismatch')
  await waitFor('disabled stopped action',()=>cdp.eval("(()=>{const b=[...document.querySelectorAll('[data-slot=page-options] button')].filter(e=>e.textContent?.trim()==='Stop run…');return b.length===1 && (b[0].disabled || b[0].getAttribute('aria-disabled')==='true')})()"),10000)
  result.checks.flowManualCleanup=true
  return { menuFrame, confirmFrame, stoppedFrame: await frame() }
}
