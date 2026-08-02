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
    // Server-side default (beta.014 test refactor): jsdom is opt-in per file via a
    // `// @vitest-environment jsdom` docblock — only the DOM/component suites need it. Under the
    // old global jsdom, ~105 API/lib files paid its startup cost (hundreds of cumulative seconds
    // per run) AND lost fidelity: axios silently switches to its XHR adapter under jsdom (see the
    // header of __tests__/integration/qbit-live.test.ts).
    environment: 'node',
    // Replaces ~99 per-file beforeEach(vi.clearAllMocks) blocks. This is mockClear (call history
    // only) — implementations like setup-global's mockResolvedValue defaults survive every test.
    clearMocks: true,
    // Global mocks for logger/audit/auth-options/notifications/next-cache — the per-file copies
    // these replace lived in ~130 files. See __tests__/helpers/setup-global.ts.
    setupFiles: ['./__tests__/helpers/setup-global.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    }
  }
});