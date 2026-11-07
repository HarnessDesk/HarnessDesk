import { Service, type Context } from '@deepseek-ai/cordis'
import type { HostRuntime } from './runtime.js'
import type { IosCapability } from './ios-types.js'
import { withIosCaller } from './ios-invocation.js'
import { IosEngine, type IosEngineDependencies } from './ios-engine.js'
export type { SimDevice } from './ios-types.js'

/** Permission is checked before touching the shared host engine or parent IPC. */
export class IosService extends Service {
  static [Service.tracker] = { associate: 'ios', property: 'ctx' }
  private readonly engine: IosCapability
  constructor(ctx: Context, private readonly runtime: HostRuntime, dependencies: IosEngineDependencies & { engine?: IosCapability } = {}) {
    super(ctx, 'ios')
    this.engine = dependencies.engine ?? new IosEngine(dependencies)
    const engine = this.engine
    ctx.effect(() => () => { if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose() }, 'ios-shutdown')
  }
  async devices(...args: Parameters<IosCapability['devices']>): ReturnType<IosCapability['devices']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.devices(...args))
  }
  async diagnose(...args: Parameters<IosCapability['diagnose']>): ReturnType<IosCapability['diagnose']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.diagnose(...args))
  }
  async frame(...args: Parameters<IosCapability['frame']>): ReturnType<IosCapability['frame']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.frame(...args))
  }
  async getAppearance(...args: Parameters<IosCapability['getAppearance']>): ReturnType<IosCapability['getAppearance']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.getAppearance(...args))
  }
  async setAppearance(...args: Parameters<IosCapability['setAppearance']>): ReturnType<IosCapability['setAppearance']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.setAppearance(...args))
  }
  async booted(...args: Parameters<IosCapability['booted']>): ReturnType<IosCapability['booted']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.booted(...args))
  }
  async boot(...args: Parameters<IosCapability['boot']>): ReturnType<IosCapability['boot']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.boot(...args))
  }
  async install(...args: Parameters<IosCapability['install']>): ReturnType<IosCapability['install']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.install(...args))
  }
  async launch(...args: Parameters<IosCapability['launch']>): ReturnType<IosCapability['launch']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.launch(...args))
  }
  async terminate(...args: Parameters<IosCapability['terminate']>): ReturnType<IosCapability['terminate']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.terminate(...args))
  }
  async openUrl(...args: Parameters<IosCapability['openUrl']>): ReturnType<IosCapability['openUrl']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.openUrl(...args))
  }
  async screenshot(...args: Parameters<IosCapability['screenshot']>): ReturnType<IosCapability['screenshot']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.screenshot(...args))
  }
  async tap(...args: Parameters<IosCapability['tap']>): ReturnType<IosCapability['tap']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.tap(...args))
  }
  async interact(...args: Parameters<IosCapability['interact']>): ReturnType<IosCapability['interact']> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertIos()
    return withIosCaller(String(owner.instanceId), () => this.engine.interact(...args))
  }
}
