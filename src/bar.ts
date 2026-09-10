import { invoke } from "@tauri-apps/api/core";

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
    <div class="bar">
      <div class="bar-strip" id="bar-strip">
        <div class="bar-ticks" id="bar-ticks"></div>
        <div class="bar-now" id="bar-now"></div>
      </div>
      <div class="bar-labels"><span>0时</span><span>6时</span><span>12时</span><span>18时</span><span>24时</span></div>
    </div>`;

  const strip = root.querySelector<HTMLDivElement>("#bar-strip")!;
  const ticks = root.querySelector<HTMLDivElement>("#bar-ticks")!;
  for (let h = 1; h < 24; h++) {
    const t = document.createElement("div");
    t.className = "bar-tick";
    t.style.left = `${(h / 24) * 100}%`;
    ticks.append(t);
  }

  function colorFor(id: number): string {
    return COLORS[id % COLORS.length];
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
    const nowEl = root.querySelector<HTMLDivElement>("#bar-now")!;
    nowEl.style.left = `${(minutes / MINUTES_PER_DAY) * 100}%`;
    nowEl.title = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  setInterval(updateNow, 20_000);
  setInterval(render, 60_000);
  render();
}
