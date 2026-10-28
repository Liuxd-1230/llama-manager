import { expect, test } from '@playwright/test'

test('reading older messages offers a working return to latest control', async ({ page }) => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    id: `reading-${index}`, user: { content: `问题 ${index}`, display: `问题 ${index}` },
    candidates: [{ id: `answer-${index}`, content: `回答 ${index}：` + '保留阅读位置，不打断创作思路。'.repeat(25), status: 'done' }],
    active_candidate_id: `answer-${index}`,
  }))
  await page.route('**/api/v1/conversations', route => route.fulfill({ json: { conversations: [{ id: 'reading', title: '滚动阅读验收', turn_count: 20 }] } }))
  await page.route('**/api/v1/conversations/reading', route => route.fulfill({ json: { turns } }))
  await page.goto('/#/chat')
  await page.getByLabel('历史会话', { exact: true }).selectOption('reading')
  const feed = page.locator('[class*="messages"]').filter({ has: page.getByText('问题 19', { exact: true }) }).first()
  await expect(feed).toBeVisible()
  await feed.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true })); element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  const jump = page.getByRole('button', { name: '回到最新', exact: true })
  await expect(jump).toBeVisible()
  await jump.click()
  await expect.poll(() => feed.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(40)
})

test('Chinese composition commits text without sending; normal Enter sends once', async ({ page }) => {
  let requests = 0
  await page.route('**/api/v1/chat', route => {
    requests += 1
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"content_delta","delta":"输入法验收通过"}\n\ndata: [DONE]\n\n' })
  })
  await page.goto('/#/chat')
  const input = page.getByLabel('消息内容', { exact: true })
  await input.fill('中文输入确认')
  await input.dispatchEvent('compositionstart')
  // Synthetic composition does not activate the OS IME; dispatch its commit
  // key without asking Chromium to insert an unrelated native newline.
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  await expect(input).toHaveValue('中文输入确认')
  expect(requests).toBe(0)
  await input.dispatchEvent('compositionend')
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })
  await expect(input).toHaveValue('中文输入确认')
  expect(requests).toBe(0)
  await input.press('Enter')
  await expect(page.getByText('输入法验收通过', { exact: true })).toBeVisible()
  expect(requests).toBe(1)
})

test('MCP connection test stops when its edited configuration fails to save', async ({ page }) => {
  let connectionTests = 0
  const fixture = { id: 'failed-save', kind: 'mcp', name: '连接保存验收', data: { transport: 'http', url: 'http://127.0.0.1:1/mcp' }, updated_at: 0 }
  await page.route('**/api/v1/objects/mcp?*', route => route.fulfill({ json: [fixture] }))
  await page.route('**/api/v1/objects/mcp/failed-save', route => route.fulfill({ status: 400, json: { code: 'request_error', message: '配置保存验收失败' } }))
  await page.route('**/api/v1/mcp/failed-save/test', route => { connectionTests += 1; return route.fulfill({ json: { tools: [] } }) })
  await page.goto('/#/assets')
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page.getByRole('button', { name: /连接保存验收/ }).click()
  await page.getByRole('textbox', { name: 'HTTP 地址', exact: true }).fill('http://127.0.0.1:2/mcp')
  await page.getByRole('button', { name: '测试连接与发现工具', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('配置保存验收失败')
  expect(connectionTests).toBe(0)
  await expect(page.getByRole('textbox', { name: 'HTTP 地址', exact: true })).toHaveValue('http://127.0.0.1:2/mcp')
})
