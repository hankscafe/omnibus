import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

// Bridge eslint-config-next's eslintrc-style shareable configs ("next/core-web-vitals",
// "next/typescript") into ESLint 9 flat config. eslint-config-next ships legacy .eslintrc configs
// (no native flat exports), so FlatCompat is the supported way to consume them on flat config — same
// rule set as before, just adapted to ESLint 9. (Run via `npm run lint` → `eslint .`.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Preserve eslint-config-next's default ignores under flat config.
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  {
    // Pragmatic relaxation of stock next/typescript strictness. This codebase uses `any` pervasively
    // (Prisma mocks, dynamic scrape payloads) and was historically gated on tsc + vitest rather than
    // eslint, so these high-volume STYLISTIC rules are demoted to warnings to keep `npm run lint` a
    // meaningful *error* gate. Genuinely actionable rules (ts-comment bans, unsafe Function type,
    // require-style imports, prefer-const, hooks deps) stay as-is and are fixed in code.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        // Don't flag unused `catch (e)` bindings — `catch (e) {}` is idiomatic and not dead code.
        caughtErrors: "none",
      }],
      "react/no-unescaped-entities": "warn",
    },
  },
  {
    // Standalone CommonJS Node scripts (src/scripts/*.js) legitimately use require().
    files: ["**/*.js", "**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
