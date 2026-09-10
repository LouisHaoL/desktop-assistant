/** 右上角浮动通知。主窗口与其他窗口共用,从 main.ts 抽出以便复用 */
export function toast(title: string, body: string, ms = 8000) {
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
