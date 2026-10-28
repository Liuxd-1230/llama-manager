import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

test('Atelier project, segmented draft, persistence, assets and responsive shell', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/#/')
  await expect(page).toHaveTitle('Atelier')
  await expect(page.getByRole('heading', { name: '接着创作' })).toBeVisible()
  const name = `验收创作 ${info.project.name} ${Date.now()}`
  await page.getByLabel('开始一个创作项目').fill(name)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByLabel('当前创作项目')).toHaveValue(/.+/)
  await page.getByRole('button', { name: '文稿', exact: true }).click()
  const text = `A quiet riverside studio, soft daylight. ${info.project.name}`
  await page.getByRole('textbox', { name: '画面内容', exact: true }).fill(text)
  await page.getByRole('button', { name: '添加一段' }).click()
  await page.getByRole('textbox', { name: '新段落内容', exact: true }).fill('Warm reflected light on the walls.')
  await page.getByTitle('固定段落').first().click()
  await expect(page.getByRole('textbox', { name: '画面内容', exact: true })).toHaveAttribute('readonly')
  await page.route('**/api/v1/text/transform', route => route.fulfill({json:{text:'Warm reflected sunlight along the walls.'}}))
  await page.getByRole('button',{name:'润色',exact:true}).last().click()
  await expect(page.locator('ins')).toHaveText('Warm reflected sunlight along the walls.')
  await mkdir(resolve('../.impeccable/review'),{recursive:true})
  await page.screenshot({path:resolve('../.impeccable/review',`pending-proposal-${info.project.name}.png`),animations:'disabled'})
  await page.getByRole('button',{name:'驳回',exact:true}).click()
  await expect(page.getByText('已保存', { exact: true }).first()).toBeVisible()
  await page.getByRole('link', { name: '下载', exact: true }).click()
  await expect(page.getByRole('heading', { name: '下载', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '创作', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '画面内容', exact: true })).toHaveValue(text)
  await page.reload()
  await page.getByRole('button', { name: '文稿', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '画面内容', exact: true })).toHaveValue(text)
  await expect(page.getByRole('textbox', { name: '画面内容', exact: true })).toHaveAttribute('readonly')
  await page.getByRole('button', {name:'编译选项',exact:true}).click()
  await page.getByLabel('提示词输出目标').selectOption('plain')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '编译提示词', exact: true }).click()
  await expect(page.locator('.prompt-out')).toContainText(text)
  await page.getByRole('link', { name: '素材', exact: true }).click()
  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('验收角色')
  await page.getByLabel('外貌特征', { exact: true }).fill('short dark hair, amber eyes')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('验收角色', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '引用到当前创作' }).click()
  await page.getByRole('link', { name: '下载', exact: true }).click()
  await page.getByLabel('Hugging Face 仓库链接').fill('this is not a repo')
  await page.getByRole('button', { name: '解析仓库', exact: true }).click()
  await expect(page.getByRole('alert').first()).toBeVisible()
  await page.getByRole('link', { name: '工作台', exact: true }).click()
  await expect(page.getByRole('heading', { name: '接着创作' })).toBeVisible()
  const directory = resolve('../.impeccable/review')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: resolve(directory, `atelier-home-${info.project.name}.png`) })
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: resolve(directory, `atelier-mobile-${info.project.name}.png`) })
  await expect(page.getByRole('link', { name: '下载', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('ComfyUI unavailable leaves editable settings and no automatic process stop', async ({ page }) => {
  let suspended = false
  await page.route('**/api/v1/server/suspend', route => { suspended = true; return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/v1/moss/comfy/status', route => route.fulfill({json:{url:'http://127.0.0.1:8188',reachable:false,has_workflow:false,bindings:{},fields:{},nodes:[],binding_errors:[],workflows:[],active_id:''}}))
  await page.goto('/#/studio')
  await page.getByRole('button', { name: '出图', exact: true }).last().click()
  await expect(page.getByRole('button', { name: 'Anima 预设', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
  expect(suspended).toBe(false)
})

test('capture Atelier surfaces in both themes with desktop and narrow evidence', async ({ page }, info) => {
  const directory = resolve('../.impeccable/review')
  await mkdir(directory, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.goto('/#/')
    await expect(page.getByRole('heading', { name: '接着创作' })).toBeVisible()
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTitle('切换主题', { exact: true }).click()
    for (const route of ['', 'models', 'downloads', 'assets', 'chat', 'settings', 'studio']) {
      await page.goto(`/#/${route}`)
      if (route === 'studio') await expect(page.getByRole('button', { name: '文稿', exact: true })).toBeVisible()
      else if (route) await expect(page.getByRole('heading', { name: ({ models: '模型', downloads: '下载', assets: '素材', chat: '对话', settings: '设置' } as Record<string, string>)[route], exact: true })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: resolve(directory, `${route || 'home'}-${theme}-${info.project.name}.png`), animations: 'disabled' })
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true)
      if (route === 'studio') {
        for (const mode of ['文稿','构图','出图']) {
          await page.getByRole('button',{name:mode,exact:true}).click()
          if (mode === '出图') await expect(page.getByRole('button',{name:'结果预览',exact:true})).toHaveAttribute('aria-pressed','true')
          await page.screenshot({path:resolve(directory,`creative-${mode}-${theme}-${info.project.name}.png`),animations:'disabled'})
          expect(await page.evaluate(()=>document.body.scrollWidth<=innerWidth)).toBe(true)
        }
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ['light','dark']) {
    if(await page.locator('html').getAttribute('data-theme')!==theme) await page.getByTitle('切换主题',{exact:true}).click()
    for (const route of ['', 'downloads', 'assets', 'studio', 'chat', 'settings']) {
      await page.goto(`/#/${route}`)
      if (route === 'studio') await expect(page.getByRole('button', { name: '文稿', exact: true })).toBeVisible()
      await page.screenshot({ path: resolve(directory, `${route || 'home'}-${theme}-390-${info.project.name}.png`), animations: 'disabled' })
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true)
      if(route==='studio') {
        await page.getByRole('button',{name:'出图',exact:true}).click()
        await expect(page.getByRole('button',{name:'结果预览',exact:true})).toBeVisible()
        await page.screenshot({path:resolve(directory,`creative-image-${theme}-390-${info.project.name}.png`),animations:'disabled'})
        expect(await page.evaluate(()=>document.body.scrollWidth<=innerWidth)).toBe(true)
      }
    }
  }
})
