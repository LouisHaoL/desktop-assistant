import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { toast } from "./toast";

/**
 * 插件系统:
 * - 插件 = 一段 JS 代码,存在 settings 表(键 "plugins" 的 JSON 数组),无需读写磁盘
 * - 运行方式:new Function("zda", code) 在主窗口执行,zda 是受限 API(白名单命令/存储/通知/事件)
 * - 每个启用的插件在「插件」页有自己的面板,manifest.render 往里画 UI
 * - 插件代码与主程序同权限,仅建议安装自己写的或可信来源的插件
 */

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  code: string;
}

export interface PluginCtx {
  /** 调用白名单内的应用命令(任务读写/设置/时间轴/LLM) */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** 插件私有 KV 存储(落在 settings 表,自动按插件隔离) */
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };
  toast: (title: string, body?: string) => void;
  /** 监听应用事件(task-due / tasks-changed / theme-changed…),插件停用时自动解绑 */
  on: (event: string, handler: (payload: unknown) => void) => void;
  emit: (event: string, payload?: unknown) => void;
}

interface PluginManifest {
  activate?: (ctx: PluginCtx) => void;
  deactivate?: () => void;
  render?: (container: HTMLElement, ctx: PluginCtx) => void | (() => void);
}

/// 插件允许调用的后端命令白名单
const ALLOWED_COMMANDS = new Set([
  "task_list",
  "task_create",
  "task_update",
  "task_delete",
  "task_start",
  "task_pause",
  "task_finish",
  "task_logs_for",
  "logs_today",
  "tasks_for_day",
  "timeline_today",
  "settings_get",
  "settings_set",
  "llm_chat",
]);

export const PLUGINS_KEY = "plugins";

export async function loadPluginList(): Promise<PluginEntry[]> {
  const raw = await invoke<string | null>("settings_get", { key: PLUGINS_KEY }).catch(() => null);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function savePluginList(list: PluginEntry[]) {
  await invoke("settings_set", { key: PLUGINS_KEY, value: JSON.stringify(list) });
  await emit("plugins-changed", {}).catch(() => {});
}

// ============ 运行时 ============

interface Running {
  entry: PluginEntry;
  root: HTMLElement;
  manifest: PluginManifest | null;
  cleanups: (() => void)[];
}

export class PluginHost {
  private running = new Map<string, Running>();

  constructor(private hostEl: HTMLElement) {}

  /** 按当前插件列表重挂全部启用的插件(列表变化/开关切换后调用) */
  async remountAll() {
    this.unmountAll();
    const list = await loadPluginList();
    for (const entry of list) {
      if (entry.enabled) this.mount(entry);
    }
  }

  private mount(entry: PluginEntry) {
    const root = document.createElement("section");
    root.className = "plugin-panel";
    const head = document.createElement("div");
    head.className = "plugin-panel-head";
    const title = document.createElement("b");
    title.textContent = `${entry.name} `;
    const ver = document.createElement("span");
    ver.className = "plugin-ver";
    ver.textContent = `v${entry.version}`;
    head.append(title, ver);
    const body = document.createElement("div");
    body.className = "plugin-body";
    root.append(head, body);
    this.hostEl.append(root);

    const cleanups: (() => void)[] = [];
    let manifest: PluginManifest | null = null;

    const ctx: PluginCtx = {
      invoke: (cmd, args) => {
        if (!ALLOWED_COMMANDS.has(cmd)) {
          return Promise.reject(new Error(`插件不允许调用命令:${cmd}`));
        }
        return invoke(cmd, args ?? {});
      },
      storage: {
        get: (key) =>
          invoke<string | null>("settings_get", { key: `plugin:${entry.id}:${key}` }).catch(() => null),
        set: (key, value) =>
          invoke("settings_set", { key: `plugin:${entry.id}:${key}`, value }).then(() => undefined),
      },
      toast: (t, b) => toast(t, b ?? ""),
      on: (event, handler) => {
        void listen(event, (e) => handler((e as { payload: unknown }).payload)).then((un) =>
          cleanups.push(un)
        );
      },
      emit: (event, payload) => void emit(event, payload).catch(() => {}),
    };

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("zda", `"use strict";\n${entry.code}\n`);
      fn({
        register: (m: PluginManifest) => {
          manifest = m ?? null;
        },
      });
    } catch (err) {
      body.innerHTML = `<p class="plugin-error"></p>`;
      (body.querySelector(".plugin-error") as HTMLElement).textContent = `插件加载失败:${String(err)}`;
      return;
    }

    try {
      // manifest 在回调里赋值,TS 流程分析看不到,这里显式放宽类型
      const m = manifest as PluginManifest | null;
      m?.activate?.(ctx);
      const dispose = m?.render?.(body, ctx);
      if (dispose instanceof Promise) {
        // async render:失败要在面板里看得见,不留未处理拒绝
        dispose.catch((err) => {
          const p = document.createElement("p");
          p.className = "plugin-error";
          p.textContent = `插件运行出错:${String(err)}`;
          body.append(p);
        });
      } else if (typeof dispose === "function") {
        cleanups.push(dispose);
      }
    } catch (err) {
      const p = document.createElement("p");
      p.className = "plugin-error";
      p.textContent = `插件运行出错:${String(err)}`;
      body.append(p);
    }

    this.running.set(entry.id, { entry, root, manifest, cleanups });
  }

  private unmountAll() {
    for (const r of this.running.values()) {
      try {
        r.manifest?.deactivate?.();
        r.cleanups.forEach((fn) => fn());
      } catch {
        /* 插件清理出错不阻塞其他插件 */
      }
      r.root.remove();
    }
    this.running.clear();
  }
}

// ============ 内置示例插件(一键添加,可再编辑/删除) ============

export const PLUGIN_TEMPLATES: { id: string; name: string; desc: string; code: string }[] = [
  {
    id: "tpl-pomodoro",
    name: "番茄钟",
    desc: "25 分钟专注倒计时,结束弹提醒",
    code: `zda.register({
  render(el, ctx) {
    const TOTAL = 25 * 60;
    let left = TOTAL, timer = null;
    el.innerHTML = \`
      <div class="pz-clock" id="pz-time">25:00</div>
      <div class="pz-row">
        <button data-a="start"></button>
        <button data-a="reset">↺ 重置</button>
      </div>\`;
    const timeEl = el.querySelector("#pz-time");
    const startBtn = el.querySelector('[data-a="start"]');
    const draw = () => {
      timeEl.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      startBtn.textContent = timer ? "⏸ 暂停" : "▶ 开始专注";
    };
    draw();
    el.querySelector('[data-a="reset"]').onclick = () => { clearInterval(timer); timer = null; left = TOTAL; draw(); };
    startBtn.onclick = () => {
      if (timer) { clearInterval(timer); timer = null; draw(); return; }
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer); timer = null; left = TOTAL;
          ctx.toast("🍅 番茄完成", "休息 5 分钟,起来走走~");
        }
        draw();
      }, 1000);
      draw();
    };
    return () => clearInterval(timer);
  }
});`,
  },
  {
    id: "tpl-quote",
    name: "今日金句",
    desc: "随机励志一句话,点按钮换一条",
    code: `zda.register({
  render(el, ctx) {
    const QUOTES = [
      "种一棵树最好的时间是十年前,其次是现在。",
      "完成比完美重要。",
      "先把最难的做完,剩下的都是下坡路。",
      "专注当下的一步,而不是整座山。",
      "你不需要很厉害才能开始,但需要开始才能很厉害。",
      "休息也是任务的一部分。",
    ];
    el.innerHTML = \`
      <p class="pz-quote"></p>
      <div class="pz-row"><button data-a="next">换一条</button></div>\`;
    const q = el.querySelector(".pz-quote");
    const draw = () => (q.textContent = "「" + QUOTES[Math.floor(Math.random() * QUOTES.length)] + "」");
    draw();
    el.querySelector('[data-a="next"]').onclick = draw;
  }
});`,
  },
  {
    id: "tpl-note",
    name: "随手便签",
    desc: "一小块自动保存的草稿区",
    code: `zda.register({
  async render(el, ctx) {
    el.innerHTML = \`<textarea class="pz-note" rows="4" placeholder="随手记点啥…自动保存"></textarea>
      <p class="pz-hint">已自动保存到本机</p>\`;
    const ta = el.querySelector("textarea");
    ta.value = (await ctx.storage.get("draft")) ?? "";
    let t = null;
    ta.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => ctx.storage.set("draft", ta.value), 400);
    };
    return () => clearTimeout(t);
  }
});`,
  },
];
