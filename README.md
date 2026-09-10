# 桌面小助理 (Desktop Assistant)

常驻桌面的 24 小时时间轴 + 任务池助理,横条时间轴与桌宠双形态,内置 LLM 智能助手。基于 Tauri 2。

## 特性

- **24 小时时间轴** — 屏幕顶部常驻半透明横条,周期任务显示为色块段,时间指针实时移动,色块区域可交互、透明区域自动穿透
- **任务池** — 周期任务(cron 规则)+ 一次性任务,配置预估完成时长,到点提醒
- **空闲提醒** — 键鼠长时间无操作时,弹出当前任务与任务池(排除周期任务),一键完成/切换
- **桌宠形态** — 动画角色 + 任务气泡,与横条形态随时切换;支持自定义图片素材
- **插件系统** — 在设置页编写/启用 JS 插件,通过受限 API(白名单命令/存储/通知/事件)扩展功能,每个插件有独立面板
- **LLM 集成** — 自然语言建任务、空闲时智能推荐、每日复盘、预估时间校准;内置 DeepSeek / 智谱 GLM / Kimi / OpenRouter / Ollama / OpenAI / Anthropic 预设,支持任意 OpenAI 兼容接口

## 下载

前往 [Releases](https://github.com/LouisHaoL/desktop-assistant/releases) 下载 Windows 安装包(NSIS)。

## 跨平台支持

基于 Tauri 2,Windows / macOS / Linux(X11)均可编译运行。推送 `v*` 标签时 [GitHub Actions](.github/workflows/release.yml) 会自动构建三平台安装包并发布 Release。

| 功能 | Windows | macOS | Linux (X11) | Linux (Wayland) |
|------|:-------:|:-----:|:-----------:|:---------------:|
| 时间轴 / 桌宠 / 任务池 / 插件 / LLM | ✅ | ✅ | ✅ | ⚠️ 透明窗口受限 |
| 鼠标穿透(色块外区域穿透) | ✅ | ✅ | ✅ | ❌ 无全局光标 |
| 空闲检测(空闲提醒触发) | ✅ | ✅ | ✅ | ⚠️ XWayland 下可能偏大 |

平台相关实现的位置:

- **鼠标穿透**:`src-tauri/src/lib.rs` 的 `spawn_hit_monitor` 轮询光标位置,色块区域内可交互、透明区域穿透。光标位置用 Tauri 跨平台 API `cursor_position()`(Windows / macOS / X11 支持;Wayland 没有全局光标概念,拿不到时跳过该轮检测)。
- **空闲检测**:`src-tauri/src/idle.rs` — Windows 用 `GetLastInputInfo`,macOS 用 CoreGraphics `CGEventSourceSecondsSinceLastEventType`(纯 FFI,无额外依赖),Linux 用 X11 XScreenSaver 扩展(链接 `libXss`,运行时需 `libxss1`)。

### 各平台构建

构建必须在目标平台上进行(macOS 无法从 Windows/Linux 交叉编译)。打包目标已按平台拆分:主配置 `tauri.conf.json` 为 `["nsis"]`(Windows),macOS 用 `tauri.macos.conf.json`(`dmg`/`app`),Linux 用 `tauri.linux.conf.json`(`appimage`/`deb`),即:

```bash
npm run tauri build -- --config src-tauri/tauri.macos.conf.json   # macOS
npm run tauri build -- --config src-tauri/tauri.linux.conf.json   # Linux
npm run tauri build                                               # Windows
```

**Windows**(推荐,功能完整):

前置:Node 18+、Rust(stable-msvc)、VS Build Tools + Windows SDK。

**macOS**(Intel 与 Apple Silicon,CI 产出通用二进制):

```bash
xcode-select --install   # 命令行工具
npm install
npm run tauri build -- --target universal-apple-darwin --config src-tauri/tauri.macos.conf.json
```

未签名 app 首次打开需右键 → 打开;对外分发需开发者证书签名 + 公证。

**Linux**(X11,需合成器支持透明):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libxss-dev
npm install
npm run tauri build -- --config src-tauri/tauri.linux.conf.json
```

托盘功能依赖 libappindicator;空闲检测链接 `libXss`(构建装 `libxss-dev`,运行需 `libxss1`);Wayland 下透明/无边框窗口与穿透受限,建议 X11 会话。

## 开发

```bash
npm install
npm run tauri dev
```

## 架构

```
src-tauri/src/          Rust 核心
  lib.rs                应用入口、托盘、鼠标命中监视、窗口与穿透管理
  task_store.rs         任务池 + 完成记录 (SQLite)
  scheduler.rs          周期任务展开 → 到点触发
  idle.rs               平台空闲检测 (Windows: GetLastInputInfo)
  llm.rs                OpenAI 兼容 LLM 客户端
  assets.rs             桌宠自定义图片素材存取 (base64 → app_data/pet_assets)
src/                    前端 (同一套 Web UI,多种窗口皮肤)
  main.ts               入口与窗口路由
  bar.ts                时间轴横条
  pet.ts                桌宠
  task-panel.ts         任务操作面板
  plugins.ts            插件系统 (JS 插件加载与受限 API)
  providers.ts          LLM 供应商预设
```

## License

[MIT](LICENSE)
