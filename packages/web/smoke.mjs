/**
 * Димовий тест веб-інтерфейсу.
 *
 * Проганяє зібрану сторінку в справжньому браузері: обирає сценарій, крутить рік
 * гри, перевіряє, що плитки заповнились, графіки намалювались, підказка на
 * наведенні працює і в консолі немає помилок. Робить знімки екрана у світлій і
 * темній темі — щоб дивитись на верстку, а не вгадувати її.
 *
 *   npm run web:smoke
 */

import { chromium } from 'playwright';
import { existsSync as hasFile } from 'node:fs';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = process.argv[2] ?? 'dist-web';
const shots = process.argv[3] ?? 'dist-web/shots';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(path)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(4173, r));

// У контейнерах браузер лежить окремо; локально Playwright знайде свій сам.
const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(hasFile(bundled) ? { executablePath: bundled } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:4173/');
await page.waitForSelector('.scenario');
await page.screenshot({ path: shots + '/01-intro.png', fullPage: true });

// Обираємо кризовий сценарій і починаємо
await page.locator('.scenario').nth(1).click();
await page.locator('#start').click();
await page.waitForSelector('.topbar');

// Проганяємо рік
for (let i = 0; i < 4; i += 1) {
  await page.locator('[data-step="quarter"]').click();
}
await page.waitForTimeout(200);
await page.screenshot({ path: shots + '/02-dashboard.png', fullPage: true });

const week = await page.locator('.topbar__date').textContent();
const tiles = await page.locator('.tile__value').allTextContents();
const charts = await page.locator('.chart').count();
const feed = await page.locator('.feed li').count();

// Перевіряємо підказку на графіку
await page.locator('.chart__canvas').first().hover({ position: { x: 300, y: 90 } });
await page.waitForTimeout(120);
const tipVisible = await page.locator('.chart__tip').first().isVisible();

// Вкладки звітності
for (const tab of ['income', 'ratios', 'journal']) {
  await page.locator(`.tab[data-tab="${tab}"]`).click();
  await page.waitForTimeout(60);
}
const journalRows = await page.locator('table.report tr').count();
await page.locator('.tab[data-tab="ratios"]').click();
await page.screenshot({ path: shots + '/03-ratios.png', fullPage: true });

// Важіль ставки
const slider = page.locator('.lever input[type=range]').first();
await slider.fill('22');
await slider.dispatchEvent('change');
await page.waitForTimeout(60);
const leverValue = await page.locator('.lever__value').first().textContent();

// Темна тема
await page.emulateMedia({ colorScheme: 'dark' });
await page.locator('.tab[data-tab="balance"]').click();
await page.waitForTimeout(120);
await page.screenshot({ path: shots + '/04-dark.png', fullPage: true });

const report = { week, tiles, charts, feed, tipVisible, journalRows, leverValue, errors };
console.log(JSON.stringify(report, null, 2));
if (errors.length > 0) process.exitCode = 1;
await browser.close();
server.close();
