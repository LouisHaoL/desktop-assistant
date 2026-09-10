# 设计文档 — 桌面小助理

2026-09-10 定稿。市场调研结论:无现成工具同时具备"24h时间轴 + 周期/一次性任务池 + 空闲检测提醒 + LLM + 常驻横条"组合(最接近:Super Productivity 缺常驻形态,Work-Review 是被动记录)。

## 已定决策

| 决策点 | 结论 |
|---|---|
| 技术栈 | Tauri 2(Rust 核心 + Web UI),包体约 10MB |
| 应用名 | 桌面小助理(repo: desktop-assistant) |
| 常驻形态 | 横条时间轴 + 桌宠双形态,可选开关切换 |
| MVP 范围 | 核心 + 空闲检测 + LLM 全四件(4-6 周量级) |
| LLM 接入 | OpenAI 兼容统一接口,内置供应商预设 + 自定义,参考 cc-switch 的 ProviderPresets 模式 |
| 周期任务 | UI 给简单选项(每天/工作日/每周几),底层存 cron 表达式 |
| 数据存储 | 本地 SQLite |

## 数据模型

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'recurring' | 'once'
  cron TEXT,                   -- kind=recurring 时必填,如 '0 9 * * 1-5'
  start_time TEXT,             -- 建议开始时刻 HH:MM
  estimated_minutes INTEGER,   -- 预估时长
  priority INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  status TEXT DEFAULT 'todo',  -- todo | doing | done | skipped
  created_at TEXT NOT NULL,
  once_due TEXT                -- kind=once 时的目标时间
);

CREATE TABLE task_logs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  actual_minutes INTEGER,      -- 实际耗时,预估校准的数据源
  source TEXT DEFAULT 'user',  -- user | idle_prompt | llm_suggest
  note TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,        -- llm_provider / idle_threshold_minutes / ...
  value TEXT NOT NULL
);
```

## LLM 供应商预设(参考 cc-switch)

每个预设:`{ id, name, baseUrl, models[], authType, docsUrl }`。
内置:DeepSeek、智谱 GLM、Kimi(Moonshot)、OpenRouter、Ollama(local)、OpenAI、Anthropic,外加 custom(任意 OpenAI 兼容)。
配置可导出/导入 JSON,方便开源社区分享。

四个 LLM 功能 = 四个 prompt 模板,共用一个 client:
1. 自然语言建任务 → 输出 tasks 字段 JSON
2. 空闲时推荐 → 输入任务池 + 当前时间 + 近期 task_logs,输出排序建议
3. 每日复盘 → 输入当日 task_logs,输出总结报告
4. 预估校准 → 对比 estimated vs actual 历史,建议修正

## 空闲检测

| 平台 | API |
|---|---|
| Windows | `GetLastInputInfo` |
| macOS | `CGEventSourceSecondsSinceLastEventType` |
| Linux | XScreenSaver idle(X11)/ Wayland 待研究 |

触发:空闲 ≥ 阈值(默认 15 分钟,可配)→ 弹窗:当前进行中任务 + 任务池(排除周期任务),操作:完成当前 / 置顶开始新任务 / 继续当前。

## 窗口结构

1. **横条窗**:无边框、置顶、半透明、屏幕顶部;鼠标穿透开关在托盘菜单
2. **桌宠窗**:无边框透明窗,动画角色 + 气泡
3. **主面板**:任务池管理 / 周期规则配置 / LLM 设置 / 复盘报告
托盘常驻:切换形态、开关穿透、打开主面板、退出。

## 开发阶段

1. ✅ 脚手架 + 工具链
2. 任务池 CRUD + SQLite(~3 天)
3. scheduler 周期展开 + 到点提醒(~1 周)
4. 横条时间轴窗 + 桌宠窗(~1 周)
5. 空闲检测 + 空闲弹窗(3-4 天)
6. LLM 四件套(~1 周)
