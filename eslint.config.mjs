// eslint.config.mjs
import globals from "globals";
import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
    // 1. Cấu hình cơ bản (Basic setup)
    {
        files: ["**/*.ts", "**/*.tsx"], // Áp dụng cho file TypeScript
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json", // Trỏ đến file tsconfig của bạn
                sourceType: "module",
                ecmaVersion: 2022,
            },
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021
            }
        },
        plugins: {
            "@typescript-eslint": tseslint,
            "obsidianmd": obsidianmd,
        },
        // 2. Kích hoạt các rule (Quy tắc)
        rules: {
            // Rule từ TypeScript
            ...tseslint.configs.recommended.rules,

            // Rule từ Obsidian Plugin (thêm thủ công vì plugin chưa hỗ trợ Flat Config native)
            ...obsidianmd.configs.recommended.rules,

            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/ban-ts-comment": "off"
        }
    },

    {
        ignores: ["main.js", "dist/", "node_modules/", "esbuild.config.mjs", "version-bump.mjs"]
    }
];