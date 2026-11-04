# Changelog

## 0.2.1

- 中英双语 README 与市场简介;新增图标;补充安装前准备说明(游戏版本与哈希、Visual Studio Build Tools、植入件编译)。原 README 的实现说明原文挪到 `docs/internals.md`,`src/native/ADAPTING.md` 的引用随之改指那里。
  Bilingual README and market description; new icon; a "Before you install" section covering the game build and hashes, Visual Studio Build Tools and the implant build. The implementation notes from the old README moved to `docs/internals.md` unchanged, and `src/native/ADAPTING.md` now points there.
- 声明市场标签 `game`、`streaming`、`external-setup`。
  Declares the market tags `game`, `streaming` and `external-setup`.

## 0.2.0

- 适配 Cortico 0.2.0(扩展契约 world 6):浏览器界面改名 WebUI,面板源码移到 `src/webui/`,产物为 `dist/webui.js`;需要 Cortico 0.2.0 或更新版本。
  Targets Cortico 0.2.0 (world contract 6): the browser UI is now WebUI, panel sources live in `src/webui/` and build to `dist/webui.js`; requires Cortico 0.2.0 or later.
- 定义加上自描述,包里附带 `describe.json`,列出全部工具与事件。
  The definition now describes itself; `describe.json` in the package lists every tool and event.
