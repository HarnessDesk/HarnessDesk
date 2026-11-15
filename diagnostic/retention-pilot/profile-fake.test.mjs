import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fake-codex-1545.mjs', import.meta.url))
const run = async () => {
  const child = spawn(process.execPath, [fixture, 'app-server'], { env: { PATH:'/usr/bin:/bin', HD_1545_OUTPUT_BYTES:'32768' }, stdio:['pipe','pipe','pipe'] })
  const lines = createInterface({input:child.stdout})
  const closed = new Promise(resolve => child.once('close', resolve))
  try {
    return await new Promise((resolve,reject) => {
      const outputs=[], ids=[]
      const timer=setTimeout(()=>reject(new Error('fake workload deadline')),5000)
      const send=value=>child.stdin.write(JSON.stringify(value)+'\n')
      child.once('error',reject)
      lines.on('line',line=>{
        let value;try { value=JSON.parse(line) } catch { return }
        if(value.id>=100 && value.id<103 && value.result?.thread?.id) {
          const id=value.result.thread.id;ids.push(id)
          send({id:value.id+100,method:'turn/start',params:{threadId:id,input:[{type:'text',text:'Synthetic turn'}]}})
        }
        if(value.method==='item/commandExecution/requestApproval') send({id:value.id,result:{decision:'accept'}})
        if(value.method==='item/completed' && value.params?.item?.type==='commandExecution') {
          const output=value.params.item.aggregatedOutput
          if(typeof output!=='string'||output.length!==32768) { clearTimeout(timer);reject(new Error('output length'));return }
          outputs.push(createHash('sha256').update(output).digest('hex'))
          if(outputs.length===3) {clearTimeout(timer);resolve({ids,outputs});return}
          send({id:100+outputs.length,method:'thread/start',params:{cwd:'/tmp',dynamicTools:[]}})
        }
      })
      send({id:100,method:'thread/start',params:{cwd:'/tmp',dynamicTools:[]}})
    })
  } finally {lines.close();child.stdin.end();child.kill();await closed}
}

test('synthetic output is unique per thread and deterministic across runs', {timeout:15000}, async () => {
  const first=await run(), second=await run()
  assert.equal(new Set(first.ids).size,3)
  assert.equal(new Set(first.outputs).size,3)
  assert.deepEqual(second,first)
})
