import {test,expect} from '@playwright/test'

test('Agent keeps editor identity, reverses quickly and returns keyboard focus',async({page})=>{
  await page.goto('/#/studio')
  await page.getByRole('button',{name:'文稿',exact:true}).click()
  const toggle=page.locator('[data-agent-toggle]')
  const compact=page.viewportSize()!.width<=1100
  if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click()
  const editor=page.locator('.stage-slot textarea').first()
  await editor.focus()
  if(!compact){
    await page.evaluate(()=>document.querySelector<HTMLButtonElement>('[data-agent-toggle]')!.click())
    await expect(toggle).toHaveAttribute('aria-expanded','true')
    await expect(editor).toBeFocused()
  }else await toggle.click()
  await page.getByRole('button',{name:'收起 Agent',exact:true}).last().click()
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded','false')
  await toggle.click();await toggle.click();await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded','true')
  await expect(page.locator('.agent-slot')).not.toHaveAttribute('inert','')
  if(compact)await expect(page.locator('.stage-slot')).toHaveAttribute('inert','')
  else await expect(page.locator('.stage-slot')).not.toHaveAttribute('inert','')
})

test('tools menu restores focus and reduced motion keeps the complete mark',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.goto('/#/studio')
  const tools=page.getByRole('button',{name:'创作工具',exact:true})
  await tools.click();await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button',{name:'图片反推',exact:true})).toBeFocused()
  await page.keyboard.press('Escape');await expect(tools).toBeFocused()
  await expect(page.locator('.main')).toHaveCSS('transition-duration','0s')
  await page.goto('/#/about')
  await page.getByRole('button',{name:'重播标志构造',exact:true}).click()
  expect(await page.locator('figure svg[role=img]').evaluate(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'))).toBe(false)
})


test('opening a newly selected project cannot overwrite the first edit with a second boot',async({page})=>{
  let reads=0
  await page.route('**/api/v1/moss/workspace',async route=>{
    reads++;const response=await route.fetch()
    if(reads>1)await new Promise(resolve=>setTimeout(resolve,800))
    await route.fulfill({response})
  })
  await page.goto('/#/')
  await page.getByLabel('开始一个创作项目').fill('首笔编辑保护 '+Date.now())
  await page.getByRole('button',{name:'创建',exact:true}).click()
  await page.getByRole('button',{name:'文稿',exact:true}).click()
  const draft=page.getByRole('textbox',{name:'画面内容',exact:true})
  await draft.fill('Do not replace this first edit with a stale workspace response.')
  await page.waitForTimeout(1200)
  await expect(draft).toHaveValue('Do not replace this first edit with a stale workspace response.')
})
