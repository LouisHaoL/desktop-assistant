import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function toast(title: string, body: string, ms = 8000) {
  const box = document.querySelector<HTMLDivElement>("#toasts")!;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="toast-title"></div><div class="toast-body"></div>`;
  el.querySelector<HTMLElement>(".toast-title")!.textContent = title;
  el.querySelector<HTMLElement>(".toast-body")!.textContent = body;
  el.onclick = () => el.remove();
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

interface Task {
  id: number;
  name: string;
  content: string | null;
  kind: "recurring" | "once";
  cron: string | null;
  start_time: string | null;
  estimated_minutes: number | null;
  priority: number;
  pinned: boolean;
  status: "todo" | "doing" | "done" | "skipped";
  created_at: string;
  once_due: string | null;
}

interface TaskLog {
  id: number;
  task_id: number;
  started_at: string;
  ended_at: string | null;
}

const listEl = document.querySelector<HTMLUListElement>("#task-list")!;
const errEl = document.querySelector<HTMLElement>("#task-err")!;
const bannerEl = document.querySelector<HTMLElement>("#doing-banner")!;
const doingNameEl = document.querySelector<HTMLElement>("#doing-name")!;
const emptyEl = document.querySelector<HTMLElement>("#empty-hint")!;

/** 当前进行中任务的打开 log id(task_logs 里 ended_at 为空的那条) */
let openLog: { taskId: number; logId: number } | null = null;

function switchTab(tab: "pool" | "new") {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.querySelector<HTMLElement>("#page-pool")!.hidden = tab !== "pool";
  document.querySelector<HTMLElement>("#page-new")!.hidden = tab !== "new";
  if (tab === "pool") refresh();
}

async function refresh() {
  const tasks = await invoke<Task[]>("task_list");

  // 找到进行中任务及其打开的 log
  openLog = null;
  const doing = tasks.find((t) => t.status === "doing");
  if (doing) {
    const logs = await invoke<TaskLog[]>("task_logs_for", { taskId: doing.id });
    const open = logs.find((l) => !l.ended_at);
    if (open) openLog = { taskId: doing.id, logId: open.id };
  }
  bannerEl.hidden = !doing;
  doingNameEl.textContent = doing?.name ?? "";
  emptyEl.hidden = tasks.length > 0;

  listEl.innerHTML = "";
  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = `task task-${t.status}`;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.name;

    const badge = document.createElement("span");
    badge.className = `badge${t.kind === "recurring" ? " badge-recurring" : ""}${
      t.status === "doing" ? " badge-doing" : ""
    }`;
    badge.textContent =
      t.status === "doing" ? "进行中" : t.kind === "recurring" ? "周期" : "一次性";

    const detail = document.createElement("span");
    detail.className = "detail";
    if (t.content) {
      li.title = t.content;
      name.style.borderBottom = "1px dotted currentColor";
      name.style.cursor = "help";
    }
    const when =
      t.kind === "recurring"
        ? `cron ${t.cron}`
        : t.once_due
          ? new Date(t.once_due).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
          : "未定时间";
    detail.textContent = `${when}${t.estimated_minutes ? ` · 约 ${t.estimated_minutes} 分钟` : ""}`;

    li.append(name, badge, detail);

    if (t.status === "todo") {
      const startBtn = document.createElement("button");
      startBtn.textContent = "开始";
      startBtn.onclick = async () => {
        await invoke("task_start", { id: t.id, source: "user" });
        switchTab("pool");
        await refresh();
      };
      li.append(startBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.textContent = "删除";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      await invoke("task_delete", { id: t.id });
      await refresh();
    };
    li.append(delBtn);
    listEl.append(li);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  listen<{ id: number; name: string; content: string | null; at: string }>("task-due", (e) => {
    toast(`⏰ ${e.payload.at} 到点了`, e.payload.name);
    refresh();
  });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab as "pool" | "new"))
  );

  document.querySelector("#btn-finish")?.addEventListener("click", async () => {
    if (!openLog) return;
    await invoke("task_finish", { logId: openLog.logId });
    await refresh();
  });

  const form = document.querySelector<HTMLFormElement>("#task-form")!;
  const cronField = document.querySelector<HTMLElement>("#field-cron")!;
  const dueField = document.querySelector<HTMLElement>("#field-due")!;

  form.addEventListener("change", () => {
    const recurring = form.kind.value === "recurring";
    cronField.hidden = !recurring;
    dueField.hidden = recurring;
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    try {
      await invoke("task_create", {
        name: form["task-name"].value,
        content: form["task-content"].value || null,
        kind: form.kind.value,
        cron: form.kind.value === "recurring" ? form["task-cron"].value : null,
        start_time: null,
        estimated_minutes: form["task-est"].value ? Number(form["task-est"].value) : null,
        priority: null,
        once_due:
          form.kind.value === "once" && form["task-due"].value
            ? new Date(form["task-due"].value).toISOString()
            : null,
      });
      form.reset();
      cronField.hidden = true;
      dueField.hidden = false;
      switchTab("pool"); // 保存后回任务池,新任务直接可见
    } catch (err) {
      errEl.textContent = String(err);
    }
  };

  document.querySelector("#btn-cancel")?.addEventListener("click", () => switchTab("pool"));

  refresh();
});
