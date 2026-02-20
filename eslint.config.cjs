const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const prettierConfig = require("eslint-config-prettier");

module.exports = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "backup/**",
      ".claude/**",
      ".idea/**"
    ]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: __dirname
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs["recommended-type-checked"].rules,
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      ...prettierConfig.rules
    }
  }
];
