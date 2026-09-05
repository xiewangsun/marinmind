// ESLint 扁平配置（103-F）：typescript-eslint recommended（非类型检查档——
// 全量类型检查已由 npm run build 的 tsc -noEmit 承担，lint 侧重快速反馈）。
// 格式化职责归 Prettier（.prettierrc.json），此处不启 stylistic 规则。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// 构建产物/依赖不进 lint 范围（scripts 为一次性迁移脚本仓）
	{ ignores: ["main.js", "node_modules/**", "scripts/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			// 空 catch 是本库既定惯例（catch 处注释说明且调用方无从恢复）
			"no-empty": ["error", { allowEmptyCatch: true }],
			// 插件侧 console 是有意为之（启动横幅/诊断信息）
			"no-console": "off",
			// 中文注释/正则里的全角空白是 CJK 代码库合法用法（字符串默认已跳过）
			"no-irregular-whitespace": [
				"error",
				{ skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true },
			],
			// 回调桥接处的具名 this 别名（home-view 的 const view = this 为既定写法）
			"@typescript-eslint/no-this-alias": ["error", { allowedNames: ["view", "self"] }],
			// 未用参数/变量以下划线开头豁免（接口约定/解构占位）
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},
);
