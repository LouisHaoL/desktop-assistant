# 桌面小助理 (Desktop Assistant)

常驻桌面的 24 小时时间轴 + 任务池助理,横条时间轴与桌宠双形态,内置 LLM 智能助手。基于 Tauri 2,跨 Windows / macOS / Linux。

## 特性

- **24 小时时间轴** — 屏幕顶部常驻半透明横条,周期任务显示为色块段,时间指针实时移动,鼠标穿透可开关
- **任务池** — 周期任务(cron 规则)+ 一次性任务,配置预估完成时长,到点提醒
- **空闲提醒** — 键鼠长时间无操作时,弹出当前任务与任务池(排除周期任务),一键完成/切换
- **桌宠形态** — 动画角色 + 任务气泡,与横条形态可随时切换
- **LLM 集成** — 自然语言建任务、空闲时智能推荐、每日复盘、预估时间校准;内置 DeepSeek / 智谱 GLM / Kimi / OpenRouter / Ollama / OpenAI / Anthropic 预设,支持任意 OpenAI 兼容接口

## 开发

```powershell
npm install
npm run tauri dev    # 开发模式
npm run tauri build  # 打包
```

前置条件:Node 18+、Rust(stable-msvc)、平台构建工具(Windows 需 VS Build Tools + Windows SDK)。

## 架构

```
src-tauri/src/          Rust 核心
  task_store.rs         任务池 + 完成记录 (SQLite)
  scheduler.rs          周期任务展开 → 到点触发
  idle_monitor.rs       平台空闲检测 (GetLastInputInfo / CGEventSource / X11)
  llm_client.rs         OpenAI 兼容客户端
src/                    前端 (同一套 Web UI,三种窗口皮肤)
  provider-presets.ts   LLM 供应商预设(参考 cc-switch 模式)
```

## License

待定(建议 MIT)。
