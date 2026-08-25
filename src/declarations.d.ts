// esbuild 以 binary loader 将 .wasm 内联进 bundle（见 esbuild.config.mjs 的 loader 配置）
declare module "*.wasm" {
	const content: Buffer;
	export default content;
}
