/** Typed element lookup that fails loudly if the markup and code drift apart. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3200): void {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', kind === 'error');
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}  ${Math.abs(lon).toFixed(5)}° ${ew}`;
}
