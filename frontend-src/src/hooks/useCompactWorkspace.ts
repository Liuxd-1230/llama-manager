import { useSyncExternalStore } from 'react'
const query = '(max-width: 1100px)'
const subscribe = (notify: () => void) => { const media=window.matchMedia(query);media.addEventListener('change',notify);return()=>media.removeEventListener('change',notify) }
export const useCompactWorkspace = () => useSyncExternalStore(subscribe,()=>window.matchMedia(query).matches,()=>false)
