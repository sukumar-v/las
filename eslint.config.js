import js from "@eslint/js";
import tseslint from "typescript-eslint";
import las from "./tools/eslint-plugin-las/index.js";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "prototypes/**", "**/*.d.ts", "packages/studio/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    // The no-fixed-design-language rule: component and screen code never carries a color, font, radius or shadow.
    files: ["packages/ui/src/**/*.{ts,tsx}", "packages/studio/src/**/*.{ts,tsx}"],
    ignores: ["packages/ui/src/theme/base.ts", "packages/ui/src/theme/css.ts"],
    plugins: { las },
    rules: { "las/no-hardcoded-style": "error" }
  }
);
