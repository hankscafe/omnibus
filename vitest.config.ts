import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import react from '@vitejs/plugin-react'; // Ensure you have this installed

export default defineConfig({
  plugins: [
    react(), // Required for processing JSX/TSX in components
    tsconfigPaths()
  ],
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Change environment from 'node' to 'jsdom' to support browser APIs
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    }
  }
});