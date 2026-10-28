import { api } from '../../api'
import { boot, flushSave, useStore } from './store'

let switching: Promise<void> | null = null

/** Save before leaving, then select and load as one serialized transition. */
export function activateProject(id: string): Promise<void> {
  const operation = (switching || Promise.resolve()).catch(() => undefined).then(async () => {
    await flushSave()
    await api(`/api/v1/projects/${id}/select`, { method: 'POST' })
    useStore.setState({ ready: false })
    await boot()
  })
  switching = operation
  void operation.finally(() => { if (switching === operation) switching = null }).catch(() => undefined)
  return operation
}
