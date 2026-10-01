import type { paths } from './generated/api'

export type ApiPaths = paths

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Default 60s timeout protects CRUD calls from a hung backend. Any endpoint
// that legitimately runs long must pass an explicit timeoutMs — slow ones today:
// update/check (300s), update/pull (600s), knowledge/search (180s).
// Chat generation does NOT go through here: ChatPage uses raw fetch with a
// user-controlled AbortController, so tool calls and web search are never cut off.
export async function api<T>(url: string, init: RequestInit = {}, timeoutMs = 60000): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: init.signal ?? controller.signal,
    })
    const text = await response.text()
    let payload: unknown = {}
    try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text } }
    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'error' in payload ? String((payload as { error: unknown }).error)
        : typeof payload === 'object' && payload && 'message' in payload ? String((payload as { message: unknown }).message) : `HTTP ${response.status}`
      throw new ApiError(message, response.status)
    }
    return payload as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new ApiError('请求超时', 408)
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export function wsUrl(path: string) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${path}`
}

export function uid(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`
}
