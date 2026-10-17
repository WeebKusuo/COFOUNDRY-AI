import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'migrate-cli': 'src/db/migrate-cli.ts',
    'seed-cli': 'src/db/seed-cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared workspace package is TypeScript source; bundle it into the server output.
  noExternal: ['@cofoundry/shared'],
  // Native addon: resolved from node_modules at runtime, never bundled.
  external: ['@node-rs/argon2'],
});
