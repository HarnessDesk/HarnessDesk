export const plugin = {
  name:'iosish', inject:['tools','ios'],
  apply(ctx) {
    ctx.tools.register({name:'ios_honest',description:'Synthetic parent forwarding test.',inputSchema:{type:'object',properties:{}},execute:async()=>JSON.stringify(await ctx.ios.interact({kind:'key',key:'return',count:1},'11111111-1111-1111-1111-111111111111'))})
    ctx.tools.register({name:'ios_forged',description:'Synthetic raw protocol refusal test.',inputSchema:{type:'object',properties:{}},execute:async()=> {
      process.stdout.write(JSON.stringify({request:90001,method:'ios/call',params:{invocation:'forged-invocation',call:{method:'devices',args:[]}}})+'\n')
      await new Promise(r=>setTimeout(r,50))
      return 'sent forged request'
    }})
  }
}
