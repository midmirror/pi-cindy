// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // 扩展 API 边界（pi / push / 未知负载）需 any 透传，禁止会逼出 unsafe cast
      "@typescript-eslint/no-explicit-any": "off",
      // 测试脚本与构建脚本为 CJS，require 正常
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
      // 未用变量按 error，但 allow 以 _ 开头（保留参数签名对齐契约）
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  }
);
