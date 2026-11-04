# 植物大战僵尸 · Plants vs. Zombies

[中文](#中文) · [English](#english)

让 Coo 玩原版 PopCap《植物大战僵尸》:从菜单、选卡到关卡里的种植和铲除都由 Coo 自己操作。
Lets Coo play the original PopCap Plants vs. Zombies, from the menus and seed picker to planting and shovelling on the lawn.

## 中文

Coo 通过注入游戏的原生植入件读游戏内存，拿到按语义整理好的画面：当前界面、棋盘每一格、卡片冷却、阳光、关卡进度。Coo 按这些信息排动作,World 在游戏窗口里替 Coo 点。适合直播，或者看 Coo 一关一关打过去。

这是在 CortiV 直播(可缇)里验证过的参考实现。别的 Persona 或非直播场景的兼容性没有测过。

### 功能

- 读出当前界面、能点的菜单项、棋盘每格的植物和僵尸、哪些卡片能用、阳光和关卡进度(`pvz_observe`)
- 一次排一串动作：选存档、选卡、种植、铲除、收金币和奖杯、点菜单，任务结束时回执结果(`pvz_do`、`pvz_queue`、`pvz_stop`)
- 预设条件触发：某排僵尸走近、卡片就绪、某格空出来时自动出手(`pvz_arm`)
- 阳光由 World 自动收，不占 Coo 的回合
- 冒险模式和多数小游戏都能玩，包括传送带关、砸罐子、锤僵尸、僵王博士、种星星、传送门、保龄球、老虎机、我是僵尸、僵尸水族馆
- 雾里、黑暗里、隐形僵尸这些玩家看不见的东西不告诉 Coo
- 关卡开始、结束、重开时提示 Coo 用一句中文短句口播
- 模型能看图时,Coo 还可以截一张游戏画面(`pvz_glance`)

游戏里的光标是植入件在游戏窗口里自己画的，带一个像素小伙伴(素材在 [`cursor-companion/`](https://github.com/Phantivia/cortico-world-pvz/tree/main/cursor-companion)),不移动系统鼠标。Coo 打关时你照常用鼠标。

### 安装前准备

1. **游戏本体**。包里不带游戏，要自备这一个版本:GOTY 1.2.0.1073,PopCap 亚太日文分支的中文资源版(配置名 `goty-apac-ja-chs-south_sniper`)。`PlantsVsZombies.exe` 与 `main.pak` 放在同一目录，大小与 SHA-256 必须是:

   | 文件 | 字节数 | SHA-256 |
   |---|---|---|
   | `PlantsVsZombies.exe` | 3 703 808 | `9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed` |
   | `main.pak` | 50 651 354 | `89971bafb5bee1d5de9012007b469c65e6147a1b12cf5058be3292ff8c6ba9b8` |

   在 PowerShell 里用 `Get-FileHash .\PlantsVsZombies.exe` 和 `Get-FileHash .\main.pak` 核对。别的版本(包括常见的英文 1.2.0.1073)在注入前就被拒绝。适配别的版本见 [ADAPTING.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/native/ADAPTING.md)。
2. **Visual Studio Build Tools**。植入件在你的电脑上从源码编译，需要带 x86 C++ 工具链的 Visual Studio 2022 或 Build Tools 2022:在 Visual Studio Installer 里勾「使用 C++ 的桌面开发」,确认含 MSVC x86/x64 生成工具(`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`)和 Windows SDK。编译脚本先用 PATH 上的 `cl.exe`,没有就用 `vswhere` 找安装位置，再不行试 `%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools`。装好后，在开始菜单打开「x86 Native Tools Command Prompt for VS 2022」,输入 `cl` 能看到编译器版本。
3. **植入件**。源码在 [`src/native/`](https://github.com/Phantivia/cortico-world-pvz/tree/main/src/native)(注入器 `injector.cpp`、植入件 `implant.cpp`、编译脚本 `build.cmd`),包里不带编译好的文件，也不下载任何东西。第一次点「启动游戏」时 World 自己调用 `build.cmd`,产物放在 `<部署根>/runtimes/pvz/<源码哈希>/`(配置了植入件构建目录就放那里):`pvz-injector.exe`、`pvz-implant.dll` 和记着两者哈希的 `artifacts.json`。`src/native/` 里任何文件变了都会重新编译。要手动编译，在包目录下运行 `src\native\build.cmd C:\path\to\output`。构建目录的路径里不能有 `& | < > ^ ( ) % ! "` 这些字符。

### 安装

在 Cortico 或 Coopanion 的扩展页搜 `cortico-world-pvz` 安装，重启后在 World 总览里启用。只支持 Windows,在别的系统上启用会被拒绝。

启用前先在配置页的「游戏程序(PlantsVsZombies.exe)」里选好游戏程序，否则启用时提示「请先选择 PlantsVsZombies.exe 文件」。

### 使用

1. 打开 World 页签「植物大战僵尸」,点「启动游戏」。World 按需编译植入件、核对游戏文件、启动游戏并注入，把窗口调到 800 × 600。状态变成「运行中」就连上了。
2. 之后 Coo 自己操作。界面切换、关卡开始和胜负、僵尸逼近房子、割草机触发、任务结束这些事会马上叫醒 Coo;普通的棋盘变化攒一会儿再送，对局中最多每 30 秒送一次棋盘摘要。
3. 点「停止」会关掉 World 启动的游戏。你自己关掉游戏窗口的话,World 停在「未启动」,不会自己重开。

### 配置

在配置页的「植物大战僵尸 · 游戏桥」分组，或部署 `config.json` 的 `worlds.pvz`。

| 键 | 默认 | 说明 |
|---|---|---|
| `executable` | `""` | `PlantsVsZombies.exe` 的路径，首尾的双引号会去掉 |
| `nativeBuildDir` | `""` | 植入件构建目录，空着用 `<部署根>/runtimes/pvz/` |
| `closeOnStop` | `true` | World 停下时关掉它启动的游戏 |
| `pollHz` | `15` | 读游戏状态的频率,10 到 20 |
| `cursorDurationMs` | `[80, 280]` | 游戏内光标每段移动的时长范围 |
| `actionTimeoutMs` | `5000` | 一步操作结束后等状态验证的期限 |
| `emitBoardDeltas` | `true` | 投递棋盘变化事件 |

其余见 [`src/config.ts`](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/config.ts)。

### 限制与常见问题

- 只支持上面那一个游戏版本。
- 游戏窗口要保持 800 × 600 且完整在一块屏幕里。最小化或拖出屏幕时 Coo 的点击和截图会被拒绝，窗口回来后自动恢复。
- 本地编译的注入器没有签名，开着「智能应用控制」的 Windows 可能拦下它。排查方法见 Cortico 的 [docs/runtimes.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/runtimes.md)。
- 引擎子进程崩溃而游戏还开着时,World 会自动重新接上,10 分钟内最多 4 次。
- 实现细节(进程边界、感知边界、任务队列、特殊关卡)见 [docs/internals.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/docs/internals.md),原生桥见 [src/native/README.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/native/README.md)。

## English

Coo reads the game's memory through a native implant injected into the game, and gets the screen as semantic state: the current screen, every cell of the board, card cooldowns, sun and level progress. Coo queues actions from that, and the World clicks them inside the game window. Made for a stream, or for watching Coo work through the levels.

This is a reference implementation verified on the CortiV live stream (Corti). Compatibility with other Personas or outside a live stream has not been tested.

### Features

- Reads the current screen, the menu actions available, the plants and zombies in every cell, which cards are usable, sun and level progress (`pvz_observe`)
- Queues a series of actions: pick a profile, pick seeds, plant, shovel, collect coins and trophies, press menu items, with a receipt when the task ends (`pvz_do`, `pvz_queue`, `pvz_stop`)
- Arms triggers that act when zombies approach a row, a card becomes ready or a cell frees up (`pvz_arm`)
- Collects sun automatically, so Coo does not spend turns on it
- Plays Adventure and most minigames, including conveyor levels, Vasebreaker, Whack a Zombie, Dr. Zomboss, Seeing Stars, Portal Combat, Wall-nut Bowling, Slot Machine, I, Zombie and Zombiquarium
- Keeps from Coo what a player cannot see: fog, darkness, invisible zombies
- Asks Coo for one short spoken line in Chinese when a level starts, ends or restarts
- When the model accepts images, Coo can take a screenshot of the game (`pvz_glance`)

The in-game cursor is drawn by the implant inside the game window, with a small pixel companion (art in [`cursor-companion/`](https://github.com/Phantivia/cortico-world-pvz/tree/main/cursor-companion)). It never moves the system mouse, so you can keep using yours while Coo plays.

### Before you install

1. **The game.** It is not in the package. You need this exact build: GOTY 1.2.0.1073, the PopCap APAC Japanese branch with Chinese resources (profile `goty-apac-ja-chs-south_sniper`). `PlantsVsZombies.exe` and `main.pak` sit in the same folder with these sizes and SHA-256 hashes:

   | File | Bytes | SHA-256 |
   |---|---|---|
   | `PlantsVsZombies.exe` | 3 703 808 | `9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed` |
   | `main.pak` | 50 651 354 | `89971bafb5bee1d5de9012007b469c65e6147a1b12cf5058be3292ff8c6ba9b8` |

   Check them in PowerShell with `Get-FileHash .\PlantsVsZombies.exe` and `Get-FileHash .\main.pak`. Any other build, including the common English 1.2.0.1073, is refused before injection. Adapting to another build is described in [ADAPTING.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/native/ADAPTING.md).
2. **Visual Studio Build Tools.** The implant is compiled from source on your machine, which needs Visual Studio 2022 or Build Tools 2022 with the x86 C++ toolchain. In Visual Studio Installer pick "Desktop development with C++" and make sure it includes the MSVC x86/x64 build tools (`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`) and a Windows SDK. The build script uses `cl.exe` from PATH if there is one, otherwise finds the install with `vswhere`, and finally tries `%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools`. To confirm, open "x86 Native Tools Command Prompt for VS 2022" from the Start menu and run `cl`; it prints the compiler version.
3. **The implant.** Its source is in [`src/native/`](https://github.com/Phantivia/cortico-world-pvz/tree/main/src/native) (`injector.cpp`, `implant.cpp` and the `build.cmd` script). Nothing prebuilt ships and nothing is downloaded. The first time you press 启动游戏 (Start game), the World runs `build.cmd` itself and writes `pvz-injector.exe`, `pvz-implant.dll` and an `artifacts.json` with both hashes to `<deployment root>/runtimes/pvz/<source hash>/`, or to the build folder you configured. Any change under `src/native/` triggers a rebuild. To build by hand, run `src\native\build.cmd C:\path\to\output` from the package folder. The build folder path cannot contain `& | < > ^ ( ) % ! "`.

### Install

Search for `cortico-world-pvz` on the Extensions page of Cortico or Coopanion and install it, restart, then enable it in the World overview. Windows only; enabling it on another system is refused.

Before enabling, choose the game in 游戏程序(PlantsVsZombies.exe) (game program) on the configuration page. Otherwise enabling stops with 请先选择 PlantsVsZombies.exe 文件 (choose PlantsVsZombies.exe first).

### Usage

1. Open the 植物大战僵尸 World tab and press 启动游戏 (Start game). The World builds the implant if needed, checks the game files, launches and injects the game, and sizes its window to 800 × 600. It is connected once the status reads 运行中 (running).
2. From there Coo plays on its own. Screen changes, a level starting, a win or loss, zombies near the house, a lawn mower going off and a finished task wake Coo right away. Ordinary board changes are batched, and during a level a board summary arrives at most every 30 seconds.
3. 停止 (Stop) closes the game the World started. If you close the game window yourself, the World stays at 未启动 (stopped) and does not relaunch it.

### Configuration

In the 植物大战僵尸 · 游戏桥 group on the configuration page, or `worlds.pvz` in the deployment's `config.json`.

| Key | Default | Meaning |
|---|---|---|
| `executable` | `""` | Path to `PlantsVsZombies.exe`; surrounding double quotes are stripped |
| `nativeBuildDir` | `""` | Implant build folder; empty means `<deployment root>/runtimes/pvz/` |
| `closeOnStop` | `true` | Close the game the World launched when the World stops |
| `pollHz` | `15` | How often game state is read, 10 to 20 |
| `cursorDurationMs` | `[80, 280]` | Duration range of one in-game cursor move |
| `actionTimeoutMs` | `5000` | How long to wait for the state to confirm a finished step |
| `emitBoardDeltas` | `true` | Deliver board change events |

The rest is in [`src/config.ts`](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/config.ts).

### Limitations and FAQ

- Only the one game build above is supported.
- The game window has to stay 800 × 600 and wholly on one monitor. While it is minimized or off screen, Coo's clicks and screenshots are refused; they resume when the window is back.
- The locally built injector is unsigned, and Windows with Smart App Control enforcing may block it. See Cortico's [docs/runtimes.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/runtimes.md) for how to check.
- If the engine child process crashes while the game is still running, the World reattaches on its own, at most 4 times in 10 minutes.
- Implementation details (process boundary, perception boundary, task queue, special levels) are in [docs/internals.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/docs/internals.md); the native bridge is described in [src/native/README.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/src/native/README.md).

## 开发 · Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test    # native-*.test.ts 只在装了 x86 MSVC 的 Windows 上跑 / native fixtures run only on Windows with x86 MSVC
corepack pnpm build   # esbuild → dist/webui.js
```

开发时 `cortico/*` 解析到 `cortico` devDependency。During development `cortico/*` resolves through the `cortico` devDependency. Third-party notices: [THIRD_PARTY_NOTICES.md](https://github.com/Phantivia/cortico-world-pvz/blob/main/THIRD_PARTY_NOTICES.md).

## 许可 · License

MIT
