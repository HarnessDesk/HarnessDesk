import type { IosCapability } from '@harnessdesk/cordis-host'
import type { IosCall } from '@harnessdesk/extension-protocol'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Validate the untrusted wire shape after the parent has checked its own invocation and manifest. */
export async function answerIosCall(engine: IosCapability, call: IosCall): Promise<unknown> {
  if (!call || typeof call !== 'object' || !Array.isArray(call.args)) throw new Error('Malformed simulator capability request.')
  const args: readonly unknown[]=call.args
  const target = (index: number, required = false) => {
    const value=args[index]
    if (value === undefined && !required) return undefined
    if(typeof value!=='string' || !uuid.test(value)) throw new Error('A simulator target must be a concrete device UUID.')
    return value
  }
  const text = (index: number) => { const value=args[index]; if(typeof value!=='string' || !value || value.length>32768) throw new Error('Expected a bounded simulator argument.'); return value }
  const counts: Record<string, readonly [number, number]> = { devices:[0,0],diagnose:[0,0],frame:[0,1],getAppearance:[0,1],setAppearance:[1,2],booted:[0,1],boot:[1,2],install:[1,2],launch:[1,2],terminate:[1,2],openUrl:[1,2],screenshot:[0,1],tap:[2,3],interact:[1,2] }
  const count=counts[call.method]
  if (!count) throw new Error('Unknown simulator capability operation.')
  if (args.length<count[0] || args.length>count[1]) throw new Error('Malformed simulator argument count.')
  switch(call.method) {
    case 'devices': if(args.length) throw new Error('Unexpected simulator arguments.'); return engine.devices()
    case 'diagnose': if(args.length) throw new Error('Unexpected simulator arguments.'); return engine.diagnose()
    case 'frame': return engine.frame(target(0))
    case 'getAppearance': return engine.getAppearance(target(0))
    case 'setAppearance': if(args[0]!=='light' && args[0]!=='dark') throw new Error('Appearance must be light or dark.'); return engine.setAppearance(args[0],target(1))
    case 'booted': return engine.booted(target(0))
    case 'boot': {
      const options=args[1]
      if(options!==undefined && (!options || typeof options!=='object' || Object.keys(options).some(k=>k!=='openWindow') || ('openWindow' in options && typeof options.openWindow!=='boolean'))) throw new Error('Malformed simulator boot options.')
      return engine.boot(target(0,true)!,options as {openWindow?:boolean}|undefined)
    }
    case 'install': return engine.install(text(0),target(1))
    case 'launch': return engine.launch(text(0),target(1))
    case 'terminate': return engine.terminate(text(0),target(1))
    case 'openUrl': return engine.openUrl(text(0),target(1))
    case 'screenshot': return engine.screenshot(target(0))
    case 'tap': if(typeof args[0]!=='number' || typeof args[1]!=='number') throw new Error('Expected screenshot coordinates.'); return engine.tap(args[0],args[1],target(2))
    case 'interact': return engine.interact(call.args[0],target(1))
    default: throw new Error('Unknown simulator capability operation.')
  }
}
