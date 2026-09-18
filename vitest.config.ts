import { defineConfig } from "vitest/config";

// Vitest 配置（139-C）。默认环境 node——jsdom 测试仍靠文件首行
// `// @vitest-environment jsdom` pragma 声明（handwrite-layer.dom / tray-unload.dom
// 先例），此处不按目录改环境以免吞掉 pragma 语义。
// coverage：v8 provider，量 src/ 行覆盖（1367 用例的真实盲区可见化）。
export default defineConfig({
	test: {
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/declarations.d.ts"],
			// 报告口径：终端摘要 + 网页报告（coverage/index.html 可本地开看热力图）
			reporter: ["text", "html"],
		},
	},
});
