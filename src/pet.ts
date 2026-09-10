import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Task {
  id: number;
  name: string;
  content: string | null;
  status: string;
}

interface Occurrence {
  task_id: number;
  name: string;
  start_minute: number;
}

const IDLE_LINES = ["今天也要加油鸭~", "没任务就摸会儿鱼吧 🐟", "点我可以看任务哦", "记得多喝水!"];

const WIN = getCurrentWindow();

export function initPet() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="pet-wrap" id="pet-wrap">
      <div class="pet-bubble" id="pet-bubble">加载中…</div>
      <div class="pet-body" id="pet-body" title="按住拖动;单击说话;🔒 可锁定位置">
        <span class="pet-emoji" id="pet-emoji">🐱</span>
        <span class="pet-status-dot" id="pet-dot"></span>
      </div>
      <button class="pet-lock" id="pet-lock" title="锁定 / 解锁拖动">🔓</button>
    </div>`;

  const bubble = root.querySelector<HTMLDivElement>("#pet-bubble")!;
  const dot = root.querySelector<HTMLElement>("#pet-dot")!;
  const bodyEl = root.querySelector<HTMLElement>("#pet-body")!;
  const lockBtn = root.querySelector<HTMLButtonElement>("#pet-lock")!;
  let msgIndex = 0;
  let statusText = "";
  let locked = false;

  // ---- 锁定 / 解锁拖动,状态存 settings ----
  async function applyLock() {
    try {
      locked = (await invoke<string | null>("settings_get", { key: "pet_locked" })) === "1";
    } catch {
      locked = false;
    }
    lockBtn.textContent = locked ? "🔒" : "🔓";
    lockBtn.classList.toggle("locked", locked);
  }

  // ---- 手动拖拽:按住移动超过 4px 就开始拖窗口;没移动的算单击(说话) ----
  let downPos: { x: number; y: number } | null = null;
  bodyEl.addEventListener("mousedown", (e) => {
    if (locked || e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY };
  });
  bodyEl.addEventListener("mousemove", (e) => {
    if (!downPos) return;
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) {
      downPos = null;
      void WIN.startDragging();
    }
  });
  window.addEventListener("mouseup", () => (downPos = null));

  lockBtn.addEventListener("click", async () => {
    const locked = lockBtn.classList.contains("locked");
    await invoke("settings_set", { key: "pet_locked", value: locked ? "0" : "1" });
    await applyLock();
    speak(locked ? "可以拖动我啦~" : "我站在这儿不动了");
  });

  // ---- 位置记忆 ----
  let saveTimer: number | undefined;
  void WIN.onMoved(async ({ payload }) => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        const sc = await WIN.scaleFactor();
        await invoke("settings_set", { key: "pet_x", value: String(Math.round(payload.x / sc)) });
        await invoke("settings_set", { key: "pet_y", value: String(Math.round(payload.y / sc)) });
      } catch {
        /* 存不上就下次还用默认位置 */
      }
    }, 600);
  });

  async function refreshStatus() {
    try {
      const tasks = await invoke<Task[]>("task_list");
      const doing = tasks.find((t) => t.status === "doing");
      if (doing) {
        dot.classList.add("busy");
        statusText = `正在做:${doing.name}`;
        return;
      }
      dot.classList.remove("busy");
      const occ = await invoke<Occurrence[]>("timeline_today").catch(() => [] as Occurrence[]);
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const next = occ
        .filter((o) => o.start_minute >= nowMin)
        .sort((a, b) => a.start_minute - b.start_minute)[0];
      statusText = next
        ? `下个任务 ${String(Math.floor(next.start_minute / 60)).padStart(2, "0")}:${String(
            next.start_minute % 60
          ).padStart(2, "0")} ${next.name}`
        : "今天没有安排~";
    } catch {
      statusText = "唤醒失败,戳戳我?";
    }
  }

  function speak(text: string) {
    bubble.textContent = text;
    bubble.classList.add("show");
    setTimeout(() => bubble.classList.remove("show"), 8000);
  }

  root.querySelector("#pet-emoji")?.addEventListener("click", () => {
    msgIndex += 1;
    const lines = [statusText, ...IDLE_LINES];
    speak(lines[msgIndex % lines.length]);
  });

  // 到点提醒也要从桌宠嘴里说出来(系统通知可能被吞)
  void listen<{ name: string; at: string }>("task-due", (e) => {
    speak(`⏰ ${e.payload.at} 该做「${e.payload.name}」啦`);
  });

  setInterval(refreshStatus, 30_000);
  void applyLock();
  refreshStatus().then(() => speak(statusText));
}
