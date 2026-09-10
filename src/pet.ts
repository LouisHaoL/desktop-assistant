import { invoke } from "@tauri-apps/api/core";

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

export function initPet() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="pet-wrap" data-tauri-drag-region>
      <div class="pet-bubble" id="pet-bubble">加载中…</div>
      <div class="pet-body" data-tauri-drag-region>
        <span class="pet-emoji" id="pet-emoji">🐱</span>
        <span class="pet-status-dot" id="pet-dot"></span>
      </div>
    </div>`;

  const bubble = root.querySelector<HTMLDivElement>("#pet-bubble")!;
  const dot = root.querySelector<HTMLElement>("#pet-dot")!;
  let msgIndex = 0;
  let statusText = "";

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
      const next = occ.filter((o) => o.start_minute >= nowMin).sort((a, b) => a.start_minute - b.start_minute)[0];
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

  setInterval(refreshStatus, 30_000);
  refreshStatus().then(() => speak(statusText));
}
