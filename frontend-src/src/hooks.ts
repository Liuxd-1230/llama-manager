import { useEffect, useRef } from 'react'
import { wsUrl } from './api'

export function useInterval(callback: () => void, delay: number) {
  const saved = useRef(callback)
  useEffect(() => { saved.current = callback }, [callback])
  useEffect(() => {
    const id = window.setInterval(() => saved.current(), delay)
    return () => window.clearInterval(id)
  }, [delay])
}

export function useWebSocket(path: string, onMessage: (text: string) => void, enabled = true) {
  const callback = useRef(onMessage)
  useEffect(() => { callback.current = onMessage }, [onMessage])
  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | undefined
    let timer = 0
    let stopped = false
    let delay = 1000
    const connect = () => {
      if (stopped) return
      socket = new WebSocket(wsUrl(path))
      socket.onopen = () => { delay = 1000 }
      socket.onmessage = event => callback.current(String(event.data))
      socket.onclose = () => {
        if (!stopped) timer = window.setTimeout(connect, delay = Math.min(delay * 2, 30000))
      }
    }
    connect()
    return () => { stopped = true; window.clearTimeout(timer); socket?.close() }
  }, [enabled, path])
}
