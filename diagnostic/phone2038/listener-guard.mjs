/** lsof field output stays private; accept only this app host's phone listener outside loopback. */
export function checkListeners(raw, owned, phonePort, appPort) {
  let pid=0,total=0,lan=0,phoneOwner=0,appOwner=0
  const counts={total:0,nonloopback:0,phoneListeners:0,appListeners:0,foreignOwners:0,unexpectedNonloopback:0}
  for(const line of raw.split('\n')) {
    if(line.startsWith('p')) pid=Number(line.slice(1))
    if(!line.startsWith('n')) continue
    total++;counts.total++
    if(!owned.has(pid)) counts.foreignOwners++
    const address=line.slice(1)
    if(new RegExp(`^127\\.0\\.0\\.1:${appPort}$`).test(address)) { appOwner=pid;counts.appListeners++ }
    if(!/^(127\.0\.0\.1|\[?::1\]?|localhost):\d+$/.test(address)) {
      counts.nonloopback++
      if(!new RegExp(`^(\\*|0\\.0\\.0\\.0|\\[?::\\]?):${phonePort}$`).test(address)) counts.unexpectedNonloopback++
      else {lan++;phoneOwner=pid;counts.phoneListeners++}
    }
  }
  const code=counts.foreignOwners ? 'foreign_owner' : counts.unexpectedNonloopback ? 'unexpected_nonloopback'
    : !total ? 'no_listeners' : lan!==1 ? 'phone_listener_count' : !appOwner ? 'app_listener_missing'
      : appOwner!==phoneOwner ? 'wrong_phone_owner' : null
  if(code) throw Object.assign(new Error('listener guard refused'),{code,counts})
  return {total,nonloopback:lan,owned:true}
}
