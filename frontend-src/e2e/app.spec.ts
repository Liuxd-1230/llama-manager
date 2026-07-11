import { expect, test, type Page } from '@playwright/test'

const pages = [
  ['配置', '#/config'],
  ['运行', '#/run'],
  ['优化', '#/optimize'],
  ['维护', '#/maintenance'],
] as const

test('five workspaces, themes, glass header and settings stay usable', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/#/config')

  for (const [title, hash] of pages) {
    await page.goto(`/${hash}`)
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expectNoOverflow(page)
  }

  await page.getByTitle('切换主题').click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('aside header strong', { hasText: '设置' })).toBeVisible()
  await page.getByRole('button', { name: '外观' }).click()
  await expect(page.getByRole('button', { name: /浅色/ })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await page.getByRole('button', { name: /浅色/ }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('light')
  await page.getByRole('button', { name: '关闭' }).click()

  await page.goto('/#/config')
  const main = page.locator('main')
  const topbar = page.locator('header').first()
  const restingBackground = await topbar.evaluate(element => getComputedStyle(element).backgroundColor)
  await main.evaluate(element => element.scrollTo(0, 500))
  await expect.poll(async () => main.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(async () => topbar.evaluate(element => getComputedStyle(element).backdropFilter)).not.toBe('none')
  await expect.poll(async () => topbar.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(restingBackground)
  await expectNoOverflow(page)
  expect(errors).toEqual([])
})

test('chat displays tool activity, safe markdown, LaTeX and candidates', async ({ page }) => {
  await mockChat(page)
  await page.goto('/#/chat')
  await expect(page.getByRole('heading', { name: '对话', exact: true })).toBeVisible()
  const composer = page.getByPlaceholder(/输入消息/)
  expect(await composer.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true)
  await composer.fill('查找最新信息')
  await page.getByRole('button', { name: /发送/ }).click()
  await expect(page.getByText('工具调用')).toBeVisible()
  await page.getByText('工具调用').click()
  await expect(page.getByText('资料已找到')).toBeVisible()
  await expect(page.locator('strong').filter({ hasText: '答案' })).toBeVisible()
  await expect(page.locator('.katex')).toBeVisible()
  await expect(page.getByRole('button', { name: /刷新/ })).toBeVisible()
  await page.getByRole('button', { name: /刷新/ }).click()
  await expect(page.getByText('2/2')).toBeVisible()
  await expect(page.getByTitle('复制代码')).toBeVisible()
  await expectNoOverflow(page)
})

async function expectNoOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }))
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport)
}

async function mockChat(page: Page) {
  await page.route('**/api/chat/providers', route => route.fulfill({ json: { providers: [{ id: 'local', name: '本地 llama.cpp', kind: 'local', enabled: true }] } }))
  await page.route('**/api/search/settings', route => route.fulfill({ json: { provider: 'tavily', providers: [{ id: 'tavily', name: 'Tavily', env_var: 'TAVILY_API_KEY', configured: true, source: 'process' }] } }))
  await page.route('**/api/chat/models', route => route.fulfill({ json: { data: [{ id: 'test-model' }] } }))
  await page.route('**/api/chat', route => {
    const events = [
      { type: 'start', candidate_id: 'candidate-backend' },
      { type: 'reasoning_delta', delta: '先查询资料。' },
      { type: 'tool_call', name: 'web_search', query: '最新信息' },
      { type: 'tool_result', name: 'web_search', summary: '资料已找到' },
      { type: 'content_delta', delta: '**答案**：公式 $x^2$\n\n```ts\nconst ok = true\n```' },
      { type: 'done' },
    ]
    const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
  })
}
