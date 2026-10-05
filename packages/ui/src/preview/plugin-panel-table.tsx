import { StoreProvider } from '../state/context'
import { store } from './harness'
import { Block } from '../slots/PanelBlocks'

/** Plugin data rendered through the same block the real slot mounts. */
export const PluginPanelTableExample = () => (
  <div data-catalog-variant="panel">
    <StoreProvider store={store}><Block block={{
      type: 'table', caption: 'Project checks',
      columns: [{ key: 'name', label: 'Name' }, { key: 'count', label: 'Runs', align: 'end' }],
      rows: [{ name: 'Review', count: '12' }, { name: 'Build' }, { name: 'Types', count: '' }],
    }} /></StoreProvider>
  </div>
)
