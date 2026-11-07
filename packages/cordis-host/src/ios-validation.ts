import type { IosAction, IosFrame } from './ios-types.js'
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A simulator input action must be an object.')
  return value as Record<string, unknown>
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const integer = (n: unknown, min: number, max: number): boolean => finite(n) && Number.isInteger(n) && n >= min && n <= max
export function validateIosAction(value: unknown, frame: Pick<IosFrame, 'width' | 'height'>): asserts value is IosAction {
  const a = record(value)
  const point = (value: unknown) => {
    const p=record(value)
    if (!finite(p['x']) || !finite(p['y']) || p['x'] < 0 || p['y'] < 0 || p['x'] >= frame.width || p['y'] >= frame.height) throw new Error('Input coordinates must be inside the current screenshot.')
  }
  const duration = () => { if (!integer(a['durationMs'],1,10000)) throw new Error('Input duration must be between 1 and 10000 milliseconds.') }
  const positive = (key: string): number => { const n=a[key]; if (!finite(n) || n<=0) throw new Error(`${key} must be positive screenshot pixels.`); return n }
  const fields: Record<string, readonly string[]> = {
    tap:['x','y','frameId'],longPress:['x','y','durationMs','frameId'],swipe:['from','to','durationMs','frameId'],drag:['path','frameId'],pinch:['center','startDistance','endDistance','durationMs','frameId'],rotateGesture:['center','radius','angleDegrees','durationMs','frameId'],text:['text'],key:['key','count'],button:['button','durationMs'],rotateDevice:['orientation'],keyboard:['visible'],
  }
  if (typeof a['kind'] !== 'string' || !fields[a['kind']] || Object.keys(a).some(k=>k!=='kind' && !fields[a['kind'] as string]!.includes(k))) throw new Error('Choose a supported typed simulator action.')
  if (a['frameId'] !== undefined && (typeof a['frameId'] !== 'string' || !a['frameId'])) throw new Error('A frame ID must be a nonempty string.')
  switch(a['kind']) {
    case 'tap': point(a); break
    case 'longPress': point(a); duration(); break
    case 'swipe': point(a['from']); point(a['to']); duration(); break
    case 'drag': {
      const path=a['path']
      if (!Array.isArray(path) || path.length<2 || path.length>600) throw new Error('A drag needs between 2 and 600 timed points.')
      let previous=-1
      for(const [i,sample] of path.entries()) { point(sample); const t=record(sample)['tMs']; if(!integer(t,0,10000) || (i===0 && t!==0) || (t as number)<=previous) throw new Error('Drag times must start at zero and strictly increase through 10000 milliseconds.'); previous=t as number }
      break
    }
    case 'pinch': {
      point(a['center']); duration()
      const center=record(a['center']); const radius=Math.max(positive('startDistance'),positive('endDistance'))/2
      point({x:(center['x'] as number)-radius,y:center['y']}); point({x:(center['x'] as number)+radius,y:center['y']}); break
    }
    case 'rotateGesture': {
      point(a['center']); duration(); const radius=positive('radius'); const center=record(a['center'])
      if(!finite(a['angleDegrees']) || Math.abs(a['angleDegrees'])>360) throw new Error('Rotation must be between -360 and 360 degrees.')
      // Validate the entire circle, a conservative bound on both generated trajectories.
      for(const x of [-radius,radius]) for(const y of [-radius,radius]) point({x:(center['x'] as number)+x,y:(center['y'] as number)+y})
      break
    }
    case 'text': if(typeof a['text']!=='string' || !a['text'].length || a['text'].length>16384) throw new Error('Text must contain between 1 and 16384 characters.'); break
    case 'key': if(!['return','delete','left','right','up','down','selectAll','undo'].includes(String(a['key'])) || !integer(a['count'],1,100)) throw new Error('Choose a supported key and a count between 1 and 100.'); break
    case 'button': if(!['home','lock','side'].includes(String(a['button']))) throw new Error('Choose home, lock or side.'); duration(); break
    case 'rotateDevice': if(!['portrait','portraitUpsideDown','landscapeLeft','landscapeRight'].includes(String(a['orientation']))) throw new Error('Choose a supported device orientation.'); break
    case 'keyboard': if(typeof a['visible']!=='boolean') throw new Error('Keyboard visibility must be true or false.'); break
  }
}
