// 将 sql.js 的 WASM 二进制内联进 bundle：插件分发时无需携带独立 .wasm 文件
// （esbuild.config.mjs 中以 binary loader 处理 .wasm 导入）
import wasmBinary from "sql.js/dist/sql-wasm.wasm";

export default wasmBinary;
