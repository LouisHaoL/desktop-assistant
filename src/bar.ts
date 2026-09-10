import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Occurrence {
  task_id: number;
  name: string;
  start_minute: number;
  duration_minutes: number;
  kind: string;
}

const COLORS = ["#4f6ef7", "#18a05e", "#e58f2a", "#b45be1", "#2ab5a5", "#e5484d", "#7a6ff0", "#0ea5e9"];
const LANES = 3;
const MINUTES_PER_DAY = 1440;

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
      <div class="bar-menu" id="bar-menu" hidden>
        <button type="button" data-act="click-through">鼠标穿透(托盘里可关闭)</button>
        <button type="button" data-act="open-main">打开主面板</button>
        <button type="button" data-act="hide-bar">隐藏横条(托盘里可恢复)</button>
      </div>
    </div>`;

  const strip = root.querySelector<HTMLDivElement>("#bar-strip")!;
  const nowEl = root.querySelector<HTMLDivElement>("#bar-now")!;
  const timeEl = root.querySelector<HTMLDivElement>("#bar-time")!;
  const menuEl = root.querySelector<HTMLDivElement>("#bar-menu")!;

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

  // 透明度设置(设置页改完会广播 bar-settings-changed)
  async function applyOpacity() {
    try {
      const v = await invoke<string | null>("settings_get", { key: "timeline_opacity" });
      const alpha = v ? Number(v) / 100 : 0.75;
      const barRoot = root.querySelector<HTMLDivElement>("#bar-root")!;
      barRoot.style.background = `rgba(10, 12, 18, ${alpha})`;
    } catch {
      /* 用默认 */
    }
  }

  async function render() {
    let occ: Occurrence[] = [];
    try {
      occ = await invoke<Occurrence[]>("timeline_today");
    } catch {
      /* 数据库尚未就绪等,下轮再试 */
    }
    strip.querySelectorAll(".bar-seg").forEach((el) => el.remove());

    // 贪心分配泳道,最多 LANES 条
    const laneEnds = Array(LANES).fill(-1);
    for (const o of occ) {
      const lane = laneEnds.findIndex((end) => end <= o.start_minute);
      if (lane === -1) continue; // 放不下的直接不画
      laneEnds[lane] = o.start_minute + o.duration_minutes;
      const seg = document.createElement("div");
      seg.className = `bar-seg${o.kind === "once" ? " bar-seg-once" : ""}`;
      seg.style.left = `${(o.start_minute / MINUTES_PER_DAY) * 100}%`;
      seg.style.width = `${Math.max((o.duration_minutes / MINUTES_PER_DAY) * 100, 0.4)}%`;
      seg.style.top = `${4 + lane * 12}px`;
      seg.style.background = colorFor(o.task_id);
      const hh = String(Math.floor(o.start_minute / 60)).padStart(2, "0");
      const mm = String(o.start_minute % 60).padStart(2, "0");
      seg.title = `[${hh}:${mm}] ${o.name}(约 ${o.duration_minutes} 分钟)`;
      strip.append(seg);
    }
    updateNow();
  }

  function updateNow() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    nowEl.style.left = `${(minutes / MINUTES_PER_DAY) * 100}%`;
    timeEl.style.left = `${(minutes / MINUTES_PER_DAY) * 100}%`;
    timeEl.textContent = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  // 右键菜单:点击穿透 / 打开主面板 / 隐藏
  const barRoot = root.querySelector<HTMLDivElement>("#bar-root")!;
  barRoot.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 110);
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    menuEl.hidden = false;
  });
  document.addEventListener("click", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target as Node)) menuEl.hidden = true;
  });
  menuEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    menuEl.hidden = true;
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
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    }
  });

  listen("bar-settings-changed", () => applyOpacity());

  setInterval(updateNow, 20_000);
  setInterval(render, 60_000);
  render();
  applyOpacity();
}
