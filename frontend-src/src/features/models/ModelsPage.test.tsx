import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { defaultConfig } from '../../types'
import { ModelsPage } from './ModelsPage'

vi.mock('../../api', () => ({ api: vi.fn() }))

const mockedApi = vi.mocked(api)

function renderPage(props: Partial<Parameters<typeof ModelsPage>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModelsPage config={defaultConfig} setConfig={() => {}} dirty={false} server={{ state: 'stopped' }} toast={() => {}} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const profile = {
  name: 'broken',
  is_current: true,
  is_running: false,
  model_path: 'E:\\gone.gguf',
  model_name: 'gone.gguf',
  model_size_mb: 0,
  model_exists: false,
  model_meta: {},
  ctx_size: 4096,
  ngl: 99,
  fit_enabled: false,
  n_cpu_moe: 0,
  kv_cache_quant_k: '',
  kv_cache_quant_v: '',
  flash_attn: false,
  mtp_enabled: false,
  host: '127.0.0.1',
  port: 8080,
}

afterEach(() => { vi.clearAllMocks() })

describe('ModelsPage', () => {
  it('shows a retryable error state instead of an empty list when loading fails', async () => {
    mockedApi.mockRejectedValue(new Error('后端未启动'))
    renderPage()
    expect(await screen.findByText(/加载档案失败/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.queryByText(/还没有档案/)).toBeNull()
  })

  it('marks profiles with missing model files and disables their launch button', async () => {
    mockedApi.mockResolvedValue({ profiles: [profile] })
    renderPage()
    expect(await screen.findByText('文件缺失')).toBeTruthy()
    const launch = screen.getByRole('button', { name: '启动' }) as HTMLButtonElement
    expect(launch.disabled).toBe(true)
  })

  it('shows the empty state when no profiles exist', async () => {
    mockedApi.mockResolvedValue({ profiles: [] })
    renderPage()
    expect(await screen.findByText(/还没有档案/)).toBeTruthy()
  })

  it('offers a stop button for the running profile', async () => {
    mockedApi.mockResolvedValue({ profiles: [{ ...profile, name: 'running-one', is_current: false, is_running: true, model_exists: true }] })
    renderPage()
    expect(await screen.findByRole('button', { name: '停止' })).toBeTruthy()
  })
})
