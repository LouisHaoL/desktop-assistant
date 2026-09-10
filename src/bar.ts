import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Occurrence {
  task_id: number;
  name: string;
  start_minute: number;
  duration_minutes: number;
  kind: string;
  status: string;
  doingLogId: number | null;
}

interface TaskRow {
  id: number;
  name: string;
  content: string | null;
  kind: string;
  cron: string | null;
  start_time: string | null;
  estimated_minutes: number | null;
  priority: number;
  pinned: boolean;
  status: string;
  created_at: string;
  once_due: string | null;
}

const COLORS = ["#4f6ef7", "#18a05e", "#e58f2a", "#b45be1", "#2ab5a5", "#e5484d", "#7a6ff0", "#0ea5e9"];
const LANES = 4;
const MINUTES_PER_DAY = 1440;
const EXPAND_H = 300; // 弹出菜单/操作面板时临时加高的窗口高度

const WIN = getCurrentWindow();

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function initBar() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="bar" id="bar-root">
      <div class="bar-strip" id="bar-strip">
        <div class="bar-ticks" id="bar-ticks"></div>
        <div class="bar-now" id="bar-now"></div>
      </div>
      <div class="bar-labels" id="bar-labels"></div>
      <div class="bar-time" id="bar-time"></div>
      <div class="bar-grip" id="bar-grip" title="拖动缩放">◢</div>
      <div class="bar-toast" id="bar-toast" hidden></div>
      <div class="bar-pop" id="bar-menu" hidden>
        <button type="button" data-act="click-through">🖱 鼠标穿透(在托盘菜单里取消)</button>
        <button type="button" data-act="open-main">📋 打开主面板</button>
        <button type="button" data-act="hide-bar">✕ 隐藏横条(托盘里恢复)</button>
      </div>
      <div class="bar-pop" id="bar-panel" hidden></div>
    </div>`;

  const strip = root.querySelector<HTMLDivElement>("#bar-strip")!;
  const nowEl = root.querySelector<HTMLDivElement>("#bar-now")!;
  const timeEl = root.querySelector<HTMLDivElement>("#bar-time")!;
  const gripEl = root.querySelector<HTMLDivElement>("#bar-grip")!;
  const toastEl = root.querySelector<HTMLDivElement>("#bar-toast")!;
  const menuEl = root.querySelector<HTMLDivElement>("#bar-menu")!;
  const panelEl = root.querySelector<HTMLDivElement>("#bar-panel")!;
  const barRoot = root.querySelector<HTMLDivElement>("#bar-root")!;

  // 整点刻度线 + 标签
  const ticks = root.querySelector<HTMLDivElement>("#bar-ticks")!;
  const labels = root.querySelector<HTMLDivElement>("#bar-labels")!;
  for (let h = 1; h < 24; h++) {
    const t = document.createElement("div");
    t.className = "bar-tick";
    if (h % 6 === 0) t.classList.add("major");
    t.style.left = `${(h / 24) * 100}%`;
    ticks.append(t);
    const label = document.createElement("span");
    label.style.position = "absolute";
    label.style.left = `${(h / 24) * 100}%`;
    label.textContent = String(h);
    labels.append(label);
  }
  const zero = document.createElement("span");
  zero.style.position = "absolute";
  zero.style.left = "0";
  zero.textContent = "0";
  labels.append(zero);

  function colorFor(id: number): string {
    return COLORS[id % COLORS.length];
  }

  // ---- 窗口高度:平时 baseH,弹菜单时临时加高(菜单原来被 56px 窗口裁掉) ----
  let baseW = 1200;
  let baseH = 56;
  let expanded = false;

  async function syncBaseSize() {
    const sc = await WIN.scaleFactor();
    const s = await WIN.innerSize();
    baseW = Math.max(320, Math.round(s.width / sc));
    baseH = Math.max(56, Math.round(s.height / sc));
  }

  async function expandWindow() {
    if (expanded) return;
    expanded = true;
    await syncBaseSize();
    await WIN.setSize(new LogicalSize(baseW, EXPAND_H));
  }

  async function collapseWindow() {
    if (!expanded) return;
    expanded = false;
    await WIN.setSize(new LogicalSize(baseW, baseH));
  }

  function closePops() {
    menuEl.hidden = true;
    panelEl.hidden = true;
    void collapseWindow();
  }

  // 位置/尺寸写回 settings(节流)
  let saveTimer: number | undefined;
  async function saveGeometry(what: "pos" | "size") {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        if (what === "pos") {
          const p = await WIN.outerPosition();
          const sc = await WIN.scaleFactor();
          await invoke("settings_set", { key: "bar_x", value: String(Math.round(p.x / sc)) });
          await invoke("settings_set", { key: "bar_y", value: String(Math.round(p.y / sc)) });
        } else {
          await syncBaseSize();
          await invoke("settings_set", { key: "bar_w", value: String(baseW) });
          await invoke("settings_set", { key: "bar_h", value: String(baseH) });
        }
      } catch {
        /* 存不上就下次还用默认布局 */
      }
    }, 600);
  }

  void WIN.onMoved(() => saveGeometry("pos"));

  // 拖动移动窗口:按住空白处(非任务段/菜单/grip)即可拖
  barRoot.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".bar-seg, .bar-pop, .bar-grip, .bar-time")) return;
    void WIN.startDragging();
  });

  // 右下角 grip 拖动缩放
  gripEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      if (expanded) await collapseWindow();
      await syncBaseSize();
      const sx = e.clientX;
      const sy = e.clientY;
      const sw = baseW;
      const sh = baseH;
      const onMove = (ev: MouseEvent) => {
        baseW = Math.max(360, sw + ev.clientX - sx);
        baseH = Math.max(56, sh + ev.clientY - sy);
        void WIN.setSize(new LogicalSize(baseW, baseH));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveGeometry("size");
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    })();
  });

  // 透明度设置(设置页改完会广播 bar-settings-changed)
  async function applyOpacity() {
    try {
      const v = await invoke<string | null>("settings_get", { key: "timeline_opacity" });
      const alpha = v ? Number(v) / 100 : 0.75;
      barRoot.style.background = `rgba(10, 12, 18, ${alpha})`;
    } catch {
      /* 用默认 */
    }
  }

  // ---- 渲染时间轴:所有任务(固定位置 + 从当前时间往后排) ----
  async function render() {
    let occ: Occurrence[] = [];
    try {
      occ = await invoke<Occurrence[]>("timeline_today");
    } catch {
      /* 数据库尚未就绪等,下轮再试 */
    }
    strip.querySelectorAll(".bar-seg").forEach((el) => el.remove());

    // 固定位置优先占泳道,再放排队的
    const laneEnds = Array(LANES).fill(-1);
    for (const o of occ) {
      const lane = laneEnds.findIndex((end) => end <= o.start_minute);
      if (lane === -1) continue; // 放不下的直接不画
      laneEnds[lane] = o.start_minute + o.duration_minutes;
      const seg = document.createElement("div");
      seg.className = `bar-seg${o.kind === "once" ? " bar-seg-once" : ""}${
        o.status === "doing" ? " bar-seg-doing" : ""
      }${o.start_minute < nowMinute() && o.status !== "doing" ? " bar-seg-queued" : ""}`;
      seg.style.left = `${(o.start_minute / MINUTES_PER_DAY) * 100}%`;
      seg.style.width = `${Math.max((o.duration_minutes / MINUTES_PER_DAY) * 100, 0.4)}%`;
      seg.style.top = `${4 + lane * 11}px`;
      seg.style.background = colorFor(o.task_id);
      seg.title = `${o.name} · ${hhmm(o.start_minute)}(约 ${o.duration_minutes} 分钟)${
        o.status === "doing" ? " · 进行中" : " · 点击操作"
      }`;
      seg.addEventListener("click", (e) => {
        e.stopPropagation();
        void openTaskPanel(o);
      });
      strip.append(seg);
    }
    updateNow();
  }

  function nowMinute(): number {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }

  function updateNow() {
    const minutes = nowMinute();
    nowEl.style.left = `${(minutes / MINUTES_PER_DAY) * 100}%`;
    timeEl.style.left = `${(minutes / MINUTES_PER_DAY) * 100}%`;
    timeEl.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  // ---- 任务快捷操作面板 ----
  async function openTaskPanel(o: Occurrence) {
    menuEl.hidden = true;
    await expandWindow();
    panelEl.innerHTML = `
      <div class="bar-panel-title"></div>
      <div class="bar-panel-meta"></div>
      <div class="bar-panel-actions"></div>`;
    panelEl.querySelector<HTMLElement>(".bar-panel-title")!.textContent = o.name;
    panelEl.querySelector<HTMLElement>(".bar-panel-meta")!.textContent =
      `${hhmm(o.start_minute)} - ${hhmm(o.start_minute + o.duration_minutes)} · 约 ${o.duration_minutes} 分钟` +
      (o.status === "doing" ? " · 进行中" : "");
    const actions = panelEl.querySelector<HTMLElement>(".bar-panel-actions")!;

    const mkBtn = (text: string, fn: () => Promise<void>, danger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      if (danger) b.className = "danger";
      b.onclick = async () => {
        try {
          await fn();
          await emit("tasks-changed", {});
        } catch (err) {
          showToast(String(err));
        }
        closePops();
        void render();
      };
      actions.append(b);
    };

    if (o.status !== "doing") {
      mkBtn("▶ 开始", async () => {
        await invoke("task_start", { id: o.task_id, source: "user" });
      });
    }
    if (o.doingLogId != null) {
      mkBtn("⏸ 暂停", async () => {
        await invoke("task_pause", { logId: o.doingLogId });
      });
      mkBtn("✓ 完成", async () => {
        await invoke("task_finish", { logId: o.doingLogId });
      });
    } else {
      // 没开始也可以直接标记完成
      mkBtn(
        "✓ 直接标记完成",
        async () => {
          const tasks = await invoke<TaskRow[]>("task_list");
          const t = tasks.find((x) => x.id === o.task_id);
          if (!t) throw new Error("任务不存在");
          await invoke("task_update", { task: { ...t, status: "done" } });
        },
        true
      );
    }
    panelEl.hidden = false;
    // 面板贴着点击位置,尽量不出窗
    panelEl.style.left = "12px";
    panelEl.style.top = "64px";
  }

  // ---- 右键菜单 ----
  barRoot.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    panelEl.hidden = true;
    void expandWindow().then(() => {
      const x = Math.min(e.clientX, window.innerWidth - 210);
      const y = Math.min(e.clientY + 8, window.innerHeight - 120);
      menuEl.style.left = `${x}px`;
      menuEl.style.top = `${y}px`;
      menuEl.hidden = false;
    });
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl.hidden && panelEl.hidden) return;
    const t = e.target as HTMLElement;
    if (!menuEl.contains(t) && !panelEl.contains(t)) closePops();
  });
  menuEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    closePops();
    if (btn.dataset.act === "click-through") {
      await invoke("set_click_through", { enable: true });
    } else if (btn.dataset.act === "open-main") {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
    } else if (btn.dataset.act === "hide-bar") {
      await collapseWindow();
      await WIN.hide();
    }
  });

  // ---- 到点提醒:横条上也要看得见(系统通知可能被吞) ----
  let toastTimer: number | undefined;
  function showToast(text: string) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 8000);
  }
  void listen<{ id: number; name: string; at: string }>("task-due", (e) => {
    showToast(`⏰ ${e.payload.at} ${e.payload.name}`);
  });
  void listen("tasks-changed", () => void render());

  setInterval(updateNow, 20_000);
  setInterval(render, 60_000);
  void render();
  void applyOpacity();
}
