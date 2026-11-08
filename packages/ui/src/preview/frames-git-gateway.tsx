import { Frame } from './main'
import { GitGatewayScene, GIT_GATEWAY_SCENES } from './git-gateway-fixture'

/** Every state renders the shipped components, on placeholder data only. */
export const GitGatewayFrames = ({ selected }: { readonly selected?: string | null }) => <>{GIT_GATEWAY_SCENES.filter(scene => !selected || scene === selected).map(scene => <Frame key={scene} id={`git-gateway-${scene}`} title={`Git gateway · ${scene}`}><GitGatewayScene scene={scene} /></Frame>)}</>
