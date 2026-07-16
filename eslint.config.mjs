import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/prisma/migrations/**", "notes/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "off", // would need type-aware linting; revisit if the suite grows
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },
  {
    // Seed/migration-style scripts are CLI tools whose entire job is to
    // print progress — not application code that should log via pino.
    files: ["**/prisma/seed.ts"],
    rules: { "no-console": "off" },
  },
  prettier,
);
