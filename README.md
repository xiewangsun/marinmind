# MarinMind

Obsidian 学习插件：**电子书阅读器 + 思维导图 + 学习卡**"一站式学习工具"。

> 口号：革新性整合阅读标注工具、思维导图和学习卡。

## 核心功能（规划中）

| 模块 | 说明 |
| ---- | ---- |
| 阅读与标注 | PDF / EPUB 阅读；文字/语音/照片/手写等多形式批注；高亮、矩形/折线摘录 |
| 摘录→卡片 | 文档中的任何摘录（文字、区域、手写、语音）自动变成一张「知识卡片」 |
| 思维导图 | 拖拽卡片构建思维导图，卡片与原文位置双向关联；支持卡片合并、链接 |
| 学习卡（闪卡） | 摘录卡片直接转为闪卡，内置间隔重复复习 |
| 多窗格工作区 | 阅读/脑图/卡片同屏多窗格切换（学习模式 / 研究模式） |
| OCR | 支持扫描版 PDF 文字识别 |
| 混合文档 | 多本书籍放进同一笔记本，跨书做一张脑图 |

## 开发

```bash
npm install    # 安装依赖
npm run dev    # 开发模式：监听 src/ 变化并增量构建 main.js
npm run build  # 生产构建：先 tsc 类型检查，再 esbuild 打包
npm test       # 运行全部测试（vitest）
```

数据存储：SQLite（sql.js / WASM），库文件位于 Obsidian 库根目录的
`.marinmind/marinmind.db`，写入防抖落盘。

开发调试：将本目录软链或复制到 Obsidian 库的 `.obsidian/plugins/marinmind/`
（需包含 `main.js`、`manifest.json`、`styles.css`），在设置中启用本插件。

## 许可证

MIT
