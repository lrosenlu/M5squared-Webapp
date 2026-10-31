// Tiny DOM helpers shared by every screen.
export const $ = (s, r = document) => r.querySelector(s);
export const view = $('#view');

/** h('div', {class: 'x', onclick: fn}, ...children): attributes, on* listeners, text and nested arrays. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export function confirmDialog(title, body, okLabel = 'Continue') {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').textContent = body;
  $('#dlgOk').textContent = okLabel;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

/** Resolve with the promise's value, or reject / resolve `onTimeout` after `ms`. */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const guard = new Promise((resolve, reject) => { timer = setTimeout(() => (typeof onTimeout === 'function' ? reject(onTimeout()) : resolve(onTimeout)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- collapsible sections: open/closed state survives re-renders (the view is rebuilt often)
const openSections = new Set();
export const isOpen = (id) => openSections.has(id);

/**
 * <details> section. `card: true` wraps it as a card; otherwise it is a flat divider inside an existing card.
 * onOpen runs when the user opens it (use it to load data lazily instead of on every render).
 */
export function section(id, title, kids, { card = true, onOpen } = {}) {
  return h('details', { class: card ? 'card fold' : 'fold inline', open: isOpen(id),
    ontoggle: (e) => { if (e.target.open) { openSections.add(id); onOpen?.(); } else openSections.delete(id); } },
  h('summary', {}, title), ...[kids].flat());
}
