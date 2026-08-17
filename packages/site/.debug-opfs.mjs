import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
page.on('worker', (worker) => {
  console.log('[worker started]', worker.url());
  worker.on('console', (message) =>
    console.log('[worker console]', message.type(), message.text()),
  );
  worker.on('close', () => console.log('[worker closed]', worker.url()));
});

await page.goto('http://localhost:4173/');
await page.getByRole('button', { name: '+ New Project' }).click();
await page.locator('#project-name-input').fill('Persist Check');
await page.getByRole('button', { name: 'Create Project' }).click();
await page.locator('.project-card', { hasText: 'Persist Check' }).waitFor();
await page.waitForTimeout(1500);

console.log('--- reloading ---');
await page.goto('http://localhost:4173/');
await page.waitForTimeout(5000);
console.log('cards after reload:', await page.locator('.project-card').count());

await browser.close();
