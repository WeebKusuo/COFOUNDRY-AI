import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'migrate-cli': 'src/db/migrate-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared workspace package is TypeScript source; bundle it into the server output.
  noExternal: ['@cofoundry/shared'],
});
