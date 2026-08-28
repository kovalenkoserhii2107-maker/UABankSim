import { defineConfig } from 'vite';

export default defineConfig({
  root: 'packages/web',
  base: './',
  build: {
    outDir: '../../dist-web',
    emptyOutDir: true,
    // Один файл на все: так збірку можна відкрити без сервера і опублікувати
    // як статичну сторінку.
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
