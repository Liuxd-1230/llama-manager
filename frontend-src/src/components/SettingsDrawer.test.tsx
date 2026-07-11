import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsDrawer } from './SettingsDrawer'

describe('SettingsDrawer', () => {
  it('shows environment status without accepting a secret value', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const payload = url.includes('/api/search/settings')
        ? { provider: 'tavily', providers: [{ id: 'tavily', name: 'Tavily', env_var: 'TAVILY_API_KEY', configured: false, source: '' }, { id: 'brave', name: 'Brave', env_var: 'BRAVE_SEARCH_API_KEY', configured: false, source: '' }] }
        : { providers: [{ id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', enabled: true, api_key_env: 'DEEPSEEK_API_KEY', api_key_set: false }] }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(<SettingsDrawer open onClose={vi.fn()} theme="light" setTheme={vi.fn()} onProvidersChanged={vi.fn()} toast={vi.fn()} />)
    await screen.findByText(/请在 .*\.env 中设置 DEEPSEEK_API_KEY/)
    expect(document.querySelector('input[type="password"]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }))
    await waitFor(() => expect(screen.getByText(/需要 TAVILY_API_KEY/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect(screen.getByRole('button', { name: /浅色/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /深色/ })).toBeInTheDocument()
  })
})
