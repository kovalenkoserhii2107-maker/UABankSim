/**
 * Складання інтерфейсу в один самодостатній HTML-файл.
 *
 * Vite віддає окремі index.html, app.css і app.js. Тут вони зшиваються в один
 * файл без жодного зовнішнього ресурсу — його можна відкрити з диска подвійним
 * кліком або опублікувати як статичну сторінку.
 *
 * Розмітка `#app` (зокрема запасний блок на випадок, коли скрипт не виконався)
 * береться з реального index.html, а не дублюється тут: одне джерело правди.
 *
 *   node packages/web/bundle.mjs dist-web dist-web/UABankSim.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist-web';
const out = process.argv[3] ?? join(dir, 'UABankSim.html');
/** `--fragment` віддає документ без обгортки html/head/body — формат Артефакту. */
const fragment = process.argv.includes('--fragment');

const html = readFileSync(join(dir, 'index.html'), 'utf8');
const css = readFileSync(join(dir, 'app.css'), 'utf8');
// Рядок усередині бандла не має закрити тег <script> зсередини.
const js = readFileSync(join(dir, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');

/**
 * Вирізає контейнер `#app` разом із вкладеним вмістом.
 *
 * Прив'язуватись до сусідніх тегів не можна: збирач вільний переставляти теги
 * скриптів між head і body. Тому рахуємо вкладеність div-ів від відкривального
 * тега — це не залежить від того, що згенерував Vite навколо.
 */
function extractApp(document) {
  const open = document.indexOf('<div id="app">');
  if (open < 0) throw new Error('bundle: у зібраному index.html немає контейнера #app');
  const tag = /<div\b[^>]*>|<\/div>/gi;
  tag.lastIndex = open;
  let depth = 0;
  for (let match = tag.exec(document); match !== null; match = tag.exec(document)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return document.slice(open, match.index + match[0].length);
  }
  throw new Error('bundle: контейнер #app не закрито');
}

const appMarkup = extractApp(html);

const parts = fragment
  ? ['<title>UABankSim</title>', '<style>', css, '</style>', appMarkup, '<script type="module">', js, '</script>', '']
  : [
      '<!doctype html>',
      '<html lang="uk">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>UABankSim</title>',
      '<style>',
      css,
      '</style>',
      '</head>',
      '<body>',
      appMarkup,
      '<script type="module">',
      js,
      '</script>',
      '</body>',
      '</html>',
      '',
    ];

const output = parts.join('\n');
writeFileSync(out, output);
console.log(`${out} — ${(output.length / 1024).toFixed(0)} КБ`);
