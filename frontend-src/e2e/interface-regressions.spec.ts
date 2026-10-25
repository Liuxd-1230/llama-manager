import { expect, test } from '@playwright/test'
import { defaultConfig } from '../src/types'

test('command import stays open for editing and restores focus on Escape', async ({ page }) => {
  await page.goto('/#/config')
  const trigger = page.getByRole('button', { name: '从命令导入' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '从启动命令导入' })
  const command = dialog.getByRole('textbox', { name: '启动命令文本' })
  await command.click()
  await command.fill('llama-server -m "E:\\models\\example.gguf" -c 8192')
  await expect(dialog).toBeVisible()
  await expect(command).toHaveValue(/8192/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('file picker keeps keyboard focus inside and returns it to the trigger', async ({ page }) => {
  await page.goto('/#/config')
  const trigger = page.getByRole('button', { name: '浏览', exact: true }).first()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '选择文件夹' })
  await expect(dialog).toBeFocused()
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('force reset requires explicit confirmation without making a request', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { ...defaultConfig, llama_cpp_dir: 'D:\\review\\llama.cpp' } }))
  let resetRequests = 0
  await page.route('**/api/update/pull', route => { resetRequests += 1; return route.fulfill({ json: { success: true } }) })
  await page.goto('/#/maintenance')
  await page.getByRole('button', { name: '强制重置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重置 llama.cpp 源码？' })
  await expect(dialog).toContainText('D:\\review\\llama.cpp')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(resetRequests).toBe(0)
})

test('failed config save preserves the draft and gives actionable feedback', async ({ page }) => {
  let releaseProfile!: () => void
  const blockedProfile = new Promise<void>(resolve => { releaseProfile = resolve })
  await page.route('**/api/profiles/current', async route => { await blockedProfile; await route.fulfill({ json: { name: 'late-profile' } }) })
  await page.route('**/api/config/save-as', route => route.fulfill({ status: 500, json: { message: '磁盘不可写' } }))
  await page.goto('/#/config')
  await page.getByLabel('配置名称', { exact: true }).fill('review-draft')
  const profileResponse = page.waitForResponse('**/api/profiles/current')
  releaseProfile()
  await profileResponse
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('保存失败')
  await expect(page.getByLabel('配置名称', { exact: true })).toHaveValue('review-draft')
})

test('narrow chat settings, composer and named navigation fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/chat')
  for (const name of ['模型厂商', '对话模型', '推理强度', '消息内容']) {
    const field = page.getByLabel(name, { exact: true })
    await expect(field).toBeVisible()
    const rect = await field.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(390)
  }
  const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
  expect(send!.y + send!.height).toBeLessThanOrEqual(844)
  for (const name of ['模型', '配置', '运行', '评测', '维护', '对话']) await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
})

test('resource threshold uses the same scale as an over-capacity estimate', async ({ page }) => {
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [{ name: 'resource-scale-test', is_current: true, is_running: false, engine: 'llama.cpp', model_path: 'review.gguf', model_name: 'review.gguf', model_size_mb: 20480, model_exists: true, model_meta: {}, ctx_size: 4096, ngl: 99, n_cpu_moe: 0, host: '127.0.0.1', port: 8080 }] } }))
  await page.goto('/#/models')
  const graph = page.getByRole('img', { name: /预计显存/ }).first()
  await expect(graph).toBeVisible()
  const measure = await graph.evaluate(element => {
    const bar = element.getBoundingClientRect()
    const marker = element.querySelector('i')!.getBoundingClientRect()
    const total = Number(element.getAttribute('aria-label')!.match(/预计显存 ([\d.]+) GB/)![1])
    return { total, markerGb: (marker.left - bar.left) / bar.width * total }
  })
  expect(measure.total).toBeGreaterThan(8)
  expect(measure.markerGb).toBeCloseTo(7.4, 1)
})

test('reduced-motion settings drawer opens without a slide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/models')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(drawer).toBeVisible()
  expect(await drawer.evaluate(element => element.getAnimations().length)).toBe(0)
  expect(await drawer.evaluate(element => getComputedStyle(element).transform)).toBe('none')
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
})
