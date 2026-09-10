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
const MINUTES_PER_DAY = 1440;

// 窗口高度固定:上面是时间轴色带,下面是透明弹层空间——
// 弹层(右键菜单/任务面板)在这块空间里展开,不改窗口尺寸,时间轴永不变形
const WINDOW_H = 300;
const LANES = 4;
const LANE_TOP = 4;
const LANE_GAP = 10;
const SEG_H = 8;

const WIN = getCurrentWindow();

// 分钟数 → 显示文本(受 12/24 小时制设置影响)
function makeHhmm(fmt: () => "24" | "12") {
  return (minute: number): string => {
    const h24 = Math.floor(minute / 60) % 24;
    const m = String(minute % 60).padStart(2, "0");
    if (fmt() === "12") {
      const suffix = h24 < 12 ? "上午" : "下午";
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${suffix}${h12}:${m}`;
    }
    return `${String(h24).padStart(2, "0")}:${m}`;
  };
}
let timeFmt: "24" | "12" = "24";
const hhmm = makeHhmm(() => timeFmt);

// 整点刻度标签
function hourLabel(h: number): string {
  if (timeFmt === "12") {
    const suffix = h < 12 ? "上午" : "下午";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${suffix}${h12}`;
  }
  return String(h);
}

export function initBar() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="bar" id="bar-root">
      <div class="bar-head">
        <div class="bar-strip" id="bar-strip">
          <div class="bar-ticks" id="bar-ticks"></div>
          <div class="bar-now" id="bar-now"></div>
        </div>
        <div class="bar-labels" id="bar-labels"></div>
        <div class="bar-time" id="bar-time"></div>
        <div class="bar-grip" id="bar-grip" title="拖动缩放宽度和高度">◢</div>
      </div>
      <div class="bar-toast" id="bar-toast" hidden></div>
      <div class="bar-pop" id="bar-menu" hidden>
        <button type="button" data-act="click-through"></button>
        <button type="button" data-act="view-mode"></button>
        <button type="button" data-act="open-settings">⚙ 设置</button>
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

  // ---- 视图范围:全天 0-24,半天只看当前上/下午(块更大) ----
  let viewMode: "full" | "half" = "full";
  let viewStart = 0;
  let viewEnd = MINUTES_PER_DAY;

  function applyViewRange() {
    if (viewMode === "half") {
      const now = nowMinute();
      if (now < 720) {
        viewStart = 0;
        viewEnd = 720;
      } else {
        viewStart = 720;
        viewEnd = MINUTES_PER_DAY;
      }
    } else {
      viewStart = 0;
      viewEnd = MINUTES_PER_DAY;
    }
  }

  function nowMinute(): number {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }

  function colorFor(id: number): string {
    return COLORS[id % COLORS.length];
  }

  // ---- 命中区域:把这些矩形报给 Rust,区域内可点、其余穿透 ----
  // 穿透模式:色带整体不作为区域,只保留每个任务色块——空白处直接穿透桌面
  async function updateRegions() {
    const regions: { x: number; y: number; w: number; h: number; kind: string }[] = [];
    const push = (el: HTMLElement, kind: string) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) regions.push({ x: r.left, y: r.top, w: r.width, h: r.height, kind });
    };
    if (ct) {
      strip.querySelectorAll<HTMLElement>(".bar-seg").forEach((seg) => push(seg, "seg"));
    } else {
      push(strip, "strip");
      push(gripEl, "grip");
    }
    if (!menuEl.hidden) push(menuEl, "menu");
    if (!panelEl.hidden) push(panelEl, "panel");
    try {
      await invoke("set_bar_hit_regions", { regions });
    } catch {
      /* 后端未就绪时下轮渲染再报 */
    }
  }

  // ---- 穿透(锁定位置)状态 ----
  let ct = false;
  async function refreshCt() {
    try {
      ct = (await invoke<string | null>("settings_get", { key: "click_through" })) === "1";
    } catch {
      ct = false;
    }
    barRoot.classList.toggle("ct", ct);
    menuEl.querySelector<HTMLButtonElement>('[data-act="click-through"]')!.textContent = ct
      ? "🔓 解除穿透(允许拖动)"
      : "🖱 鼠标穿透(锁定位置)";
    void updateRegions();
  }

  // ---- 刻度与标签(随视图范围变化) ----
  const ticks = root.querySelector<HTMLDivElement>("#bar-ticks")!;
  const labels = root.querySelector<HTMLDivElement>("#bar-labels")!;
  function renderScale() {
    const span = viewEnd - viewStart;
    ticks.innerHTML = "";
    labels.innerHTML = "";
    for (let m = viewStart; m <= viewEnd; m += 60) {
      const h = m / 60;
      if (h === 0 || h === 24) continue; // 0 点和 24 点重合,只画一次
      const t = document.createElement("div");
      t.className = "bar-tick";
      if (h % 6 === 0) t.classList.add("major");
      t.style.left = `${((m - viewStart) / span) * 100}%`;
      ticks.append(t);
      const label = document.createElement("span");
      label.style.position = "absolute";
      label.style.left = `${((m - viewStart) / span) * 100}%`;
      label.textContent = hourLabel(h % 24);
      labels.append(label);
    }
    const zero = document.createElement("span");
    zero.style.position = "absolute";
    zero.style.left = "0";
    zero.textContent = hourLabel(viewStart / 60);
    labels.append(zero);
  }

  function closePops() {
    menuEl.hidden = true;
    panelEl.hidden = true;
    void updateRegions();
  }

  // ---- 位置/尺寸写回 settings(节流) ----
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
          const s = await WIN.innerSize();
          const sc = await WIN.scaleFactor();
          await invoke("settings_set", { key: "bar_w", value: String(Math.max(320, Math.round(s.width / sc))) });
        }
      } catch {
        /* 存不上就下次还用默认布局 */
      }
    }, 600);
  }

  void WIN.onMoved(() => saveGeometry("pos"));

  // 拖动移动窗口:按住色带空白处即可拖(穿透模式下锁定)
  barRoot.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || ct) return;
    const t = e.target as HTMLElement;
    if (t.closest(".bar-seg, .bar-pop, .bar-grip, .bar-time")) return;
    void WIN.startDragging();
  });

  // 右下角 grip 拖动缩放(穿透模式下锁定)
  gripEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ct) return;
    void (async () => {
      const s = await WIN.innerSize();
      const sc = await WIN.scaleFactor();
      const sx = e.clientX;
      const sy = e.clientY;
      const sw = s.width / sc;
      const sh = s.height / sc;
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(360, sw + ev.clientX - sx);
        const h = Math.max(120, Math.min(WINDOW_H, sh + ev.clientY - sy));
        void WIN.setSize(new LogicalSize(w, h));
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
      const head = barRoot.querySelector<HTMLElement>(".bar-head")!;
      head.style.background = `rgba(10, 12, 18, ${alpha})`;
    } catch {
      /* 用默认 */
    }
  }

  // ---- 渲染时间轴:当天所有任务(固定位置 + 从当前时间往后排) ----
  async function render() {
    if (viewMode === "half") applyViewRange();
    renderScale();
    let occ: Occurrence[] = [];
    try {
      occ = await invoke<Occurrence[]>("timeline_today");
    } catch {
      /* 数据库尚未就绪等,下轮再试 */
    }
    strip.querySelectorAll(".bar-seg").forEach((el) => el.remove());

    const span = viewEnd - viewStart;
    const pct = (minute: number) => ((minute - viewStart) / span) * 100;

    // 固定位置优先占泳道,再放排队的
    const laneEnds = Array(LANES).fill(-1);
    for (const o of occ) {
      // 视图范围外的整段不画,越界的裁剪
      const segEnd = o.start_minute + o.duration_minutes;
      if (segEnd <= viewStart || o.start_minute >= viewEnd) continue;
      const left = Math.max(pct(o.start_minute), 0);
      const right = Math.min(pct(segEnd), 100);
      const lane = laneEnds.findIndex((end) => end <= o.start_minute);
      if (lane === -1) continue; // 放不下的直接不画
      laneEnds[lane] = o.start_minute + o.duration_minutes;
      const seg = document.createElement("div");
      seg.className = `bar-seg${o.kind === "once" ? " bar-seg-once" : ""}${
        o.status === "doing" ? " bar-seg-doing" : ""
      }${o.status === "done" ? " bar-seg-done" : ""}${
        o.status !== "doing" && o.status !== "done" && o.start_minute < nowMinute()
          ? " bar-seg-queued"
          : ""
      }`;
      seg.style.left = `${left}%`;
      seg.style.width = `${Math.max(right - left, 0.4)}%`;
      seg.style.top = `${LANE_TOP + lane * LANE_GAP}px`;
      seg.style.height = `${SEG_H}px`;
      seg.style.background = colorFor(o.task_id);
      seg.title = `${o.name} · ${hhmm(o.start_minute)}(约 ${o.duration_minutes} 分钟)${
        o.status === "doing" ? " · 进行中" : o.status === "done" ? " · 已完成" : " · 点击操作"
      }`;
      seg.addEventListener("click", (e) => {
        e.stopPropagation();
        void openTaskPanel(o);
      });
      strip.append(seg);
    }
    updateNow();
    void updateRegions();
  }

  function updateNow() {
    const minutes = nowMinute();
    if (minutes < viewStart || minutes > viewEnd) {
      nowEl.style.display = "none";
      timeEl.style.display = "none";
      return;
    }
    nowEl.style.display = "";
    timeEl.style.display = "";
    const span = viewEnd - viewStart;
    nowEl.style.left = `${((minutes - viewStart) / span) * 100}%`;
    timeEl.style.left = `${((minutes - viewStart) / span) * 100}%`;
    timeEl.textContent = hhmm(minutes);
  }

  // ---- 任务快捷操作面板(打开时重新查库,状态和任务池保持一致) ----
  async function openTaskPanel(o: Occurrence) {
    menuEl.hidden = true;
    // 重新取任务和打开中的执行记录,不用时间轴上的旧状态
    let fresh: TaskRow | undefined;
    let doingLogId: number | null = o.doingLogId;
    try {
      const tasks = await invoke<TaskRow[]>("task_list");
      fresh = tasks.find((x) => x.id === o.task_id);
      const logs = await invoke<{ id: number; ended_at: string | null }[]>("task_logs_for", {
        taskId: o.task_id,
      });
      doingLogId = logs.find((l) => !l.ended_at)?.id ?? null;
    } catch {
      /* 取不到就用时间轴上的数据 */
    }
    const status = fresh?.status ?? o.status;
    const name = fresh?.name ?? o.name;

    panelEl.innerHTML = `
      <div class="bar-panel-head">
        <div class="bar-panel-title"></div>
        <button type="button" class="bar-panel-close" title="关闭">✕</button>
      </div>
      <div class="bar-panel-meta"></div>
      <div class="bar-panel-actions"></div>`;
    panelEl.querySelector(".bar-panel-close")!.addEventListener("click", () => closePops());
    panelEl.querySelector<HTMLElement>(".bar-panel-title")!.textContent = name;
    panelEl.querySelector<HTMLElement>(".bar-panel-meta")!.textContent =
      `${hhmm(o.start_minute)} - ${hhmm(o.start_minute + o.duration_minutes)} · 约 ${o.duration_minutes} 分钟` +
      (status === "doing" ? " · 进行中" : status === "done" ? " · 已完成" : " · 待办");
    const actions = panelEl.querySelector<HTMLElement>(".bar-panel-actions")!;

    const setStatus = async (newStatus: string) => {
      const t = fresh ?? (await invoke<TaskRow[]>("task_list")).find((x) => x.id === o.task_id);
      if (!t) throw new Error("任务不存在");
      await invoke("task_update", { task: { ...t, status: newStatus } });
    };

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

    if (status === "done") {
      mkBtn("↩ 恢复为待办", async () => {
        await setStatus("todo");
      });
    } else {
      if (status !== "doing") {
        mkBtn("▶ 开始", async () => {
          await invoke("task_start", { id: o.task_id, source: "user" });
        });
      }
      if (doingLogId != null) {
        mkBtn("⏸ 暂停", async () => {
          await invoke("task_pause", { logId: doingLogId });
        });
        mkBtn("✓ 完成", async () => {
          await invoke("task_finish", { logId: doingLogId });
        });
      } else {
        // 没开始也可以直接标记完成
        mkBtn(
          "✓ 直接标记完成",
          async () => {
            await setStatus("done");
          },
          true
        );
      }
    }
    // 面板贴着点击位置,放在色带下方的透明空间里,不影响时间轴布局
    panelEl.style.left = "12px";
    panelEl.style.top = "70px";
    panelEl.hidden = false;
    void updateRegions();
  }

  // ---- 右键菜单 ----
  barRoot.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    panelEl.hidden = true;
    const x = Math.min(e.clientX, window.innerWidth - 210);
    const y = Math.min(e.clientY + 8, window.innerHeight - 150);
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    menuEl.hidden = false;
    void updateRegions();
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl.hidden && panelEl.hidden) return;
    const t = e.target as HTMLElement;
    if (!menuEl.contains(t) && !panelEl.contains(t)) closePops();
  });
  menuEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    closePops();
    if (act === "click-through") {
      await invoke("set_click_through", { enable: !ct });
      await refreshCt();
    } else if (act === "view-mode") {
      viewMode = viewMode === "full" ? "half" : "full";
      await invoke("settings_set", { key: "bar_view_mode", value: viewMode }).catch(() => {});
      updateModeBtn();
      void render();
    } else if (act === "open-settings") {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
      await emit("open-settings", {});
    } else if (act === "open-main") {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
    } else if (act === "hide-bar") {
      await WIN.hide();
    }
  });

  // 12/24 小时制(设置页改完会广播 bar-settings-changed)
  async function reloadTimeFmt() {
    try {
      const v = await invoke<string | null>("settings_get", { key: "bar_time_format" });
      if (v === "12" || v === "24") timeFmt = v;
    } catch {
      /* 默认 24 */
    }
    void render();
  }

  function updateModeBtn() {
    menuEl.querySelector<HTMLButtonElement>('[data-act="view-mode"]')!.textContent = `⏱ 视图:${
      viewMode === "full" ? "全天" : "半天"
    }(点击切换)`;
  }

  // ---- 到点提醒:横条上也要看得见(系统通知可能被吞) ----
  let toastTimer: number | undefined;
  function showToast(text: string) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
      void updateRegions();
    }, 8000);
    void updateRegions();
  }
  void listen<{ id: number; name: string; at: string }>("task-due", (e) => {
    showToast(`⏰ ${e.payload.at} ${e.payload.name}`);
  });
  void listen("tasks-changed", () => void render());
  // 光标移出所有命中区域(点到桌面等)时由后端通知收起右键菜单;任务面板不自动关
  void listen("bar-pops-dismiss", () => {
    menuEl.hidden = true;
    void updateRegions();
  });
  // 托盘/外部改动穿透状态后同步手柄与拖动
  void listen("bar-settings-changed", () => {
    void refreshCt();
    void applyOpacity();
    void reloadTimeFmt();
  });

  setInterval(updateNow, 20_000);
  setInterval(render, 60_000);
  (async () => {
    try {
      const mode = await invoke<string | null>("settings_get", { key: "bar_view_mode" });
      if (mode === "half" || mode === "full") viewMode = mode;
      const tf = await invoke<string | null>("settings_get", { key: "bar_time_format" });
      if (tf === "12" || tf === "24") timeFmt = tf;
    } catch {
      /* 默认全天 / 24 小时制 */
    }
    updateModeBtn();
    await refreshCt();
    await applyOpacity();
    void render();
  })();
}
