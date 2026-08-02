import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // A separate deployment target with its own toolchain (see
    // tsconfig.json's matching exclusion) — Next.js-specific rules like
    // no-assign-module-variable don't apply to a Cloudflare Worker.
    "cloudflare-worker/**",
  ]),
]);

export default eslintConfig;
