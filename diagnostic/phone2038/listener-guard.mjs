/** lsof field output stays private; accept only this app host's phone listener outside loopback. */
export function checkListeners(raw, owned, phonePort, appPort) {
  let pid=0,total=0,lan=0,phoneOwner=0,appOwner=0
  for(const line of raw.split('\n')) {
    if(line.startsWith('p')) pid=Number(line.slice(1))
    if(!line.startsWith('n')) continue
    if(!owned.has(pid)) throw Error('listener owner')
    total++
    const address=line.slice(1)
    if(new RegExp(`^127\\.0\\.0\\.1:${appPort}$`).test(address)) appOwner=pid
    if(!/^(127\.0\.0\.1|\[?::1\]?|localhost):\d+$/.test(address)) {
      if(!new RegExp(`^(\\*|0\\.0\\.0\\.0|\\[?::\\]?):${phonePort}$`).test(address)) throw Error('unexpected listener')
      lan++; phoneOwner=pid
    }
  }
  if(!total||lan!==1||!appOwner||appOwner!==phoneOwner) throw Error('listener ownership')
  return {total,nonloopback:lan,owned:true}
}
