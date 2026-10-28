import { expect, test } from '@playwright/test'

test('workflow switches atomically restore bindings and per-workflow Anima values',async({page,request})=>{
  const preset=await (await request.get('/api/v1/workflows/anima')).json()
  const first=await (await request.post('/api/v1/moss/comfy/import',{data:{name:'参数与绑定 A',workflow:JSON.stringify(preset.nodes)}})).json()
  const remapped:Record<string,any>={}
  for(const [id,value] of Object.entries(preset.nodes)){
    const node=structuredClone(value) as any
    for(const [key,input] of Object.entries(node.inputs)) if(Array.isArray(input)&&input.length===2) node.inputs[key]=[String(Number(input[0])+100),input[1]]
    remapped[String(Number(id)+100)]=node
  }
  const second=await (await request.post('/api/v1/moss/comfy/import',{data:{name:'参数与绑定 B',workflow:JSON.stringify(remapped)}})).json()
  expect(second.id).toBeTruthy()
  await request.put('/api/v1/moss/comfy/workflows/active',{data:{id:first.id}})
  await page.goto('/#/studio?panel=image')
  const workflow=page.getByLabel('当前工作流')
  await expect(workflow).toHaveValue(first.id)
  await expect(page.getByLabel('CFG',{exact:true})).toHaveValue('4.5')
  await expect(page.getByLabel('步数',{exact:true})).toHaveValue('28')
  await page.getByLabel('CFG',{exact:true}).fill('3.2')
  await workflow.selectOption(second.id)
  await expect(workflow).toHaveValue(second.id)
  await expect(page.getByLabel('CFG',{exact:true})).toHaveValue('4.5')
  const bindings=(await (await request.get('/api/v1/moss/comfy/status')).json()).bindings
  await page.getByRole('button',{name:'工作流节点',exact:true}).click()
  await page.locator('.image-ws-chip').filter({hasText:'正向提示词'}).click()
  await expect(page.locator('.comfy-inspector-head')).toContainText(`#${bindings.positive.node}`)
  expect(Number(bindings.positive.node)).toBeGreaterThan(100)
  await workflow.selectOption(first.id)
  await expect(page.getByLabel('CFG',{exact:true})).toHaveValue('3.2')
  await page.reload()
  await expect(page.getByLabel('CFG',{exact:true})).toHaveValue('3.2')
  await page.getByRole('button',{name:'恢复节点默认值'}).click()
  await expect(page.getByLabel('CFG',{exact:true})).toHaveValue('4.5')
})

test('Anima preview exposes model files before saving and retains advanced JSON',async({page})=>{
  await page.goto('/#/studio?panel=image')
  await page.getByRole('button',{name:'Anima 预设',exact:true}).click()
  await expect(page.getByText('待保存的工作流',{exact:true})).toBeVisible()
  await expect(page.getByLabel('UNETLoader · unet_name')).toBeVisible()
  await expect(page.getByLabel('CLIPLoader · clip_name')).toBeVisible()
  await page.getByText('高级 JSON 编辑',{exact:true}).click()
  await expect(page.getByRole('textbox',{name:'工作流 JSON'})).toHaveValue(/sgm_uniform/)
})

test('brand respects reduced motion, chat options are progressive, tool details are keyboard accessible',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.goto('/#/')
  await page.getByRole('button',{name:'重播标志构造'}).click()
  expect(await page.locator('figure svg[role=img]').evaluate(element=>element.getAnimations({subtree:true}).some(animation=>animation.playState==='running'))).toBe(false)
  await page.getByRole('link',{name:'对话',exact:true}).click()
  const options=page.getByRole('button',{name:'对话选项',exact:true})
  await expect(options).toHaveAttribute('aria-expanded','false')
  await options.click()
  await expect(options).toHaveAttribute('aria-expanded','true')
  await expect(page.getByText('流式',{exact:true})).toBeVisible()
})
