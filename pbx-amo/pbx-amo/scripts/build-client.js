'use strict';
// Собирает браузерную версию JsSIP из npm-пакета в public/jssip.min.js.
// Запускается автоматически после `npm install` / `yarn` (postinstall).
// Если сборка не удалась, деплой не падает: сервер стартует, а ошибка видна в логе сборки.
const path = require('path');

try {
  const esbuild = require('esbuild');
  esbuild.buildSync({
    stdin: {
      contents: "module.exports = require('jssip');",
      resolveDir: path.join(__dirname, '..'),
    },
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'JsSIP',
    platform: 'browser',
    target: ['es2018'],
    outfile: path.join(__dirname, '..', 'public', 'jssip.min.js'),
    logLevel: 'error',
  });
  console.log('[build-client] public/jssip.min.js собран');
} catch (e) {
  console.error('[build-client] НЕ УДАЛОСЬ собрать JsSIP:', e.message);
}
