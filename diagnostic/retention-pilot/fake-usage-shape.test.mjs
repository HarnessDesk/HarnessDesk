import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fake-codex-1545.mjs', import.meta.url))
test('scripted fake RPC emits complete numeric token breakdowns', { timeout: 10000 }, async () => {
  const child=spawn(process.execPath,[fixture,'app-server'],{env:{PATH:'/usr/bin:/bin',HD_1545_OUTPUT_BYTES:'32768'},stdio:['pipe','pipe','pipe']})
  const lines=createInterface({input:child.stdout})
  try {
    const usage=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('fake usage notification missing')),5000)
      child.once('error',reject)
      child.once('exit',()=>reject(new Error('fake exited before usage')))
      lines.on('line',line=>{
        let m;try{m=JSON.parse(line)}catch{return}
        if(m.id===1&&m.result?.thread?.id)child.stdin.write(JSON.stringify({id:2,method:'turn/start',params:{threadId:m.result.thread.id,input:[{type:'text',text:'Synthetic turn'}]}})+'\n')
        if(m.method==='item/commandExecution/requestApproval')child.stdin.write(JSON.stringify({id:m.id,result:{decision:'accept'}})+'\n')
        if(m.method==='thread/tokenUsage/updated'){clearTimeout(timer);resolve(m.params.tokenUsage)}
      })
      child.stdin.write(JSON.stringify({id:1,method:'thread/start',params:{cwd:'/tmp',dynamicTools:[]}})+'\n')
    })
    for(const value of [usage.total,usage.last]){
      for(const field of ['totalTokens','inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'])assert.equal(typeof value[field],'number',`${field} must be present and numeric`)
      assert.equal(value.cacheWriteInputTokens,0)
    }
  } finally {lines.close();child.stdin.end();child.kill();await new Promise(resolve=>child.once('close',resolve))}
})
