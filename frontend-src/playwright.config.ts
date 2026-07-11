import { defineConfig } from '@playwright/test'

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:9092',
    launchOptions: { executablePath: chrome },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: '1280x800', use: { viewport: { width: 1280, height: 800 } } },
    { name: '931x820', use: { viewport: { width: 931, height: 820 } } },
    { name: '1440x900', use: { viewport: { width: 1440, height: 900 } } },
    { name: '1920x1080', use: { viewport: { width: 1920, height: 1080 } } },
  ],
})
