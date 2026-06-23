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
];

export default eslintConfig;
