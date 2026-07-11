import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App, { resolveInitialTheme } from './App'
import { defaultConfig } from './types'

beforeEach(() => {
  localStorage.clear()
  window.location.hash = '#/config'
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('/api/server/status') ? { state: 'stopped' } : defaultConfig
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

describe('theme', () => {
  it('prefers the persisted light/dark choice', () => {
    localStorage.setItem('theme', 'dark')
    expect(resolveInitialTheme()).toBe('dark')
  })

  it('switches and persists the active theme', async () => {
    render(<App />)
    fireEvent.click(screen.getByTitle('切换主题'))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(localStorage.getItem('theme')).toBe('dark')
  })
})
