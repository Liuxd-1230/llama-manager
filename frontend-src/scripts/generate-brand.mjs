import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'

// This is a format export of the approved mark, never a redrawing.
const mark = JSON.parse(await fs.readFile(new URL('../src/brand/mark.json', import.meta.url), 'utf8'))
const root = new URL('../public/', import.meta.url)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" role="img" aria-label="Atelier"><path fill="#af563f" d="${mark.path}"/></svg>`
await fs.writeFile(new URL('atelier.svg', root), svg)
await fs.writeFile(new URL('brand/atelier-mark.svg', root), svg)
for (const file of ['atelier-lockup.svg','atelier-construction.svg']) {
  const path=new URL(`brand/${file}`,root)
  const source=await fs.readFile(path,'utf8')
  await fs.writeFile(path,source.replace(/d="M81 0 [^"]+"/g,`d="${mark.path}"`))
}
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true})
try {
  const page = await browser.newPage()
  for (const size of [180, 192, 512]) {
    const data = await page.evaluate(async ({svg,size}) => {
      const img = new Image(); img.src='data:image/svg+xml;base64,'+btoa(svg)
      await img.decode()
      const canvas=document.createElement('canvas');canvas.width=canvas.height=size
      canvas.getContext('2d').drawImage(img,0,0,size,size)
      return canvas.toDataURL('image/png').split(',')[1]
    },{svg,size})
    await fs.writeFile(new URL(`brand/atelier-${size}.png`,root),Buffer.from(data,'base64'))
  }
} finally { await browser.close() }
console.log('Atelier mark, favicon and PNG icons exported from src/brand/mark.json')
