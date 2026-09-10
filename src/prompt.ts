import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Task {
  id: number;
  name: string;
  content: string | null;
  status: string;
  estimated_minutes?: number | null;
}

interface IdlePayload {
  idle_minutes: number;
  doing: Task | null;
  todo: Task[];
}

const win = getCurrentWindow();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function initPrompt() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="prompt">
      <div class="prompt-head">
        <h2>歇了一会儿了</h2>
        <span class="prompt-idle" id="prompt-idle"></span>
      </div>
      <div id="prompt-doing"></div>
      <div class="prompt-sub">任务池里还有这些(不含周期任务):</div>
      <ul id="prompt-todo"></ul>
      <div class="prompt-actions">
        <button class="btn-ghost" id="prompt-continue">继续手头的事</button>
      </div>
    </div>`;

  const idleEl = root.querySelector<HTMLElement>("#prompt-idle")!;
  const doingEl = root.querySelector<HTMLElement>("#prompt-doing")!;
  const todoEl = root.querySelector<HTMLUListElement>("#prompt-todo")!;

  async function finishCurrent(doing: Task) {
    const logs = await invoke<{ id: number; ended_at: string | null }[]>("task_logs_for", {
      taskId: doing.id,
    });
    const open = logs.find((l) => !l.ended_at);
    if (open) await invoke("task_finish", { logId: open.id });
  }

  async function startTask(id: number) {
    await invoke("task_start", { id, source: "idle_prompt" });
    win.hide();
  }

  listen<IdlePayload>("idle-prompt", (e) => {
    const { idle_minutes, doing, todo } = e.payload;
    idleEl.textContent = `已闲置 ${idle_minutes} 分钟`;
    doingEl.innerHTML = "";
    todoEl.innerHTML = "";

    if (doing) {
      const card = document.createElement("div");
      card.className = "prompt-doing-card";
      card.innerHTML = `
        <div>
          <div class="prompt-label">之前在做</div>
          <div class="prompt-name">${escapeHtml(doing.name)}</div>
        </div>`;
      const doneBtn = document.createElement("button");
      doneBtn.className = "btn-primary";
      doneBtn.textContent = "已完成 ✓";
      doneBtn.onclick = async () => {
        await finishCurrent(doing);
        win.hide();
      };
      card.append(doneBtn);
      doingEl.append(card);
    }

    if (todo.length === 0) {
      todoEl.innerHTML = `<li class="prompt-empty">任务池空空如也,安心休息~</li>`;
    }
    for (const t of todo) {
      const li = document.createElement("li");
      li.className = "prompt-task";
      li.innerHTML = `<span>${escapeHtml(t.name)}${
        t.estimated_minutes ? `<em class="prompt-est">约 ${t["estimated_minutes"]} 分钟</em>` : ""
      }</span>`;
      const startBtn = document.createElement("button");
      startBtn.textContent = "开始";
      startBtn.onclick = () => startTask(t.id);
      li.append(startBtn);
      todoEl.append(li);
    }
  });

  root.querySelector("#prompt-continue")?.addEventListener("click", () => win.hide());

  // 若窗口加载时事件已发过,Rust 侧每次 idle 都会重发,这里无需兜底
}
