import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 任务快捷操作面板:独立小窗口,点击时间轴色块时在屏幕中央弹出。
 * 不挤占横条窗口的透明空间,横条在屏幕任何位置都能居中弹面板。
 */

interface Task {
  id: number;
  name: string;
  content: string | null;
  kind: string;
  cron: string | null;
  status: string;
  estimated_minutes: number | null;
  once_due: string | null;
}

interface TaskLog {
  id: number;
  ended_at: string | null;
}

const WIN = getCurrentWindow();

export function initTaskPanel() {
  document.body.classList.add("view-task-panel");
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="tp-card" id="tp-card" hidden>
      <div class="bar-panel-head">
        <div class="bar-panel-title"></div>
        <button type="button" class="bar-panel-close" title="关闭">✕</button>
      </div>
      <div class="bar-panel-meta"></div>
      <div class="tp-content"></div>
      <div class="bar-panel-actions"></div>
    </div>
    <p class="tp-waiting" id="tp-waiting">等待从时间轴打开任务…</p>`;

  const card = root.querySelector<HTMLDivElement>("#tp-card")!;
  const waiting = root.querySelector<HTMLElement>("#tp-waiting")!;

  function close() {
    card.hidden = true;
    waiting.hidden = false;
    void WIN.hide();
  }

  root.querySelector(".bar-panel-close")!.addEventListener("click", () => close());

  // 点到面板外面(切去别的窗口)就收起,不留一个悬空的置顶小窗
  void WIN.onFocusChanged(({ payload: focused }) => {
    if (!focused && !card.hidden) close();
  });

  async function setStatus(t: Task, newStatus: string) {
    await invoke("task_update", { task: { ...t, status: newStatus } });
  }

  function mkBtn(text: string, fn: () => Promise<void>, danger = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (danger) b.className = "danger";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
        await emit("tasks-changed", {});
        close();
      } catch (err) {
        b.disabled = false;
        const meta = card.querySelector<HTMLElement>(".bar-panel-meta")!;
        meta.textContent = String(err);
      }
    };
    return b;
  }

  async function showTask(taskId: number) {
    waiting.hidden = true;
    let task: Task | undefined;
    let doingLogId: number | null = null;
    let when = "";
    try {
      const tasks = await invoke<Task[]>("task_list");
      task = tasks.find((x) => x.id === taskId);
      const logs = await invoke<TaskLog[]>("task_logs_for", { taskId });
      doingLogId = logs.find((l) => !l.ended_at)?.id ?? null;
    } catch {
      /* 查不到也先把面板画出来 */
    }
    if (!task) {
      card.hidden = false;
      card.querySelector<HTMLElement>(".bar-panel-title")!.textContent = "任务不存在";
      card.querySelector<HTMLElement>(".bar-panel-meta")!.textContent = "";
      card.querySelector<HTMLElement>(".tp-content")!.textContent = "";
      card.querySelector<HTMLElement>(".bar-panel-actions")!.innerHTML = "";
      return;
    }

    if (task.kind === "recurring") {
      when = `周期 · cron ${task.cron ?? ""}`;
    } else if (task.once_due) {
      when = `一次性 · ${new Date(task.once_due).toLocaleString("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      })}`;
    } else {
      when = "一次性 · 未定时间";
    }

    card.querySelector<HTMLElement>(".bar-panel-title")!.textContent = task.name;
    card.querySelector<HTMLElement>(".bar-panel-meta")!.textContent =
      `${when}${task.estimated_minutes ? ` · 约 ${task.estimated_minutes} 分钟` : ""} · ${
        task.status === "doing" ? "进行中" : task.status === "done" ? "已完成" : "待办"
      }`;
    const content = card.querySelector<HTMLElement>(".tp-content")!;
    content.textContent = task.content || "";
    content.hidden = !task.content;
    const actions = card.querySelector<HTMLElement>(".bar-panel-actions")!;
    actions.innerHTML = "";

    if (task.status === "done") {
      actions.append(mkBtn("↩ 恢复为待办", () => setStatus(task!, "todo")));
    } else {
      if (task.status !== "doing") {
        actions.append(
          mkBtn("▶ 开始", () => invoke("task_start", { id: task!.id, source: "user" }).then(() => undefined))
        );
      }
      if (doingLogId != null) {
        actions.append(
          mkBtn("⏸ 暂停", () => invoke("task_pause", { logId: doingLogId }).then(() => undefined)),
          mkBtn("✓ 完成", () => invoke("task_finish", { logId: doingLogId }).then(() => undefined))
        );
      } else {
        actions.append(
          mkBtn(
            "✓ 直接标记完成",
            () => setStatus(task!, "done"),
            true
          )
        );
      }
    }
    card.hidden = false;
  }

  void listen<{ taskId: number }>("show-task-panel", (e) => void showTask(e.payload.taskId));
}
