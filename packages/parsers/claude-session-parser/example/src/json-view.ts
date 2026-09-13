/**
 * Lazy expandable/collapsible JSON tree. Object and array children are only
 * materialized into the DOM the first time their node is opened, so huge
 * parsed sessions (thousands of entries) stay responsive.
 */

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const MAX_AUTO_EXPAND_DEPTH = 1;
/** Nodes wider than this are left unopened by "Expand all" to bound DOM size. */
const EXPAND_ALL_MAX_CHILDREN = 200;

/** Lazy child materializers keyed by their <details> node — the 'toggle'
 *  event on <details> is dispatched asynchronously, so "Expand all" must be
 *  able to populate synchronously without waiting for it. */
const lazyPopulators = new WeakMap<HTMLDetailsElement, () => void>();

function ensurePopulated(details: HTMLDetailsElement): void {
  lazyPopulators.get(details)?.();
  lazyPopulators.delete(details);
}

function preview(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? '' : 's'} ]`;
  const keys = Object.keys(value);
  return `{ ${keys.length} key${keys.length === 1 ? '' : 's'} }`;
}

function primitiveLine(key: string | null, value: unknown): HTMLDivElement {
  const div = document.createElement('div');
  if (key !== null) {
    const k = document.createElement('span');
    k.className = 'json-key';
    k.textContent = `${key}: `;
    div.append(k);
  }
  const v = document.createElement('span');
  if (value === null) {
    v.className = 'json-null';
    v.textContent = 'null';
  } else if (typeof value === 'string') {
    v.className = 'json-str';
    v.textContent = JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value);
  } else if (typeof value === 'number') {
    v.className = 'json-num';
    v.textContent = String(value);
  } else {
    v.className = 'json-bool';
    v.textContent = String(value);
  }
  div.append(v);
  return div;
}

function populate(
  details: HTMLDetailsElement,
  value: Record<string, unknown> | unknown[],
  depth: number,
): void {
  const container = document.createElement('div');
  const items: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [`${i}`, v])
    : Object.entries(value);
  for (const [k, v] of items) {
    container.append(childNode(k, v as Json, depth));
  }
  details.append(container);
}

function branchNode(
  key: string | null,
  value: Record<string, unknown> | unknown[],
  depth: number,
): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  if (key !== null) {
    const k = document.createElement('span');
    k.className = 'json-key';
    k.textContent = `${key}: `;
    summary.append(k);
  }
  const meta = document.createElement('span');
  meta.className = 'json-meta';
  meta.textContent = preview(value);
  summary.append(meta);
  details.append(summary);

  const childCount = Array.isArray(value) ? value.length : Object.keys(value).length;
  details.dataset.childCount = String(childCount);

  lazyPopulators.set(details, () => populate(details, value, depth + 1));
  details.addEventListener('toggle', () => {
    if (details.open) ensurePopulated(details);
  });
  return details;
}

function childNode(key: string | null, value: Json, depth: number): HTMLElement {
  if (value !== null && typeof value === 'object') {
    const node = branchNode(key, value as Record<string, unknown> | unknown[], depth);
    if (depth < MAX_AUTO_EXPAND_DEPTH) {
      ensurePopulated(node);
      node.open = true;
    }
    return node;
  }
  return primitiveLine(key, value);
}

function expandAll(root: HTMLElement): void {
  const queue = Array.from(root.querySelectorAll('details'));
  while (queue.length > 0) {
    const node = queue.shift() as HTMLDetailsElement;
    ensurePopulated(node);
    node.open = true;
    if (Number(node.dataset.childCount) > EXPAND_ALL_MAX_CHILDREN) continue;
    queue.push(...Array.from(node.querySelectorAll('details')));
  }
}

export function renderJsonTree(data: unknown, container: HTMLElement): void {
  container.replaceChildren();
  container.append(childNode(null, data as Json, 0));
}

export function bindJsonControls(
  root: HTMLElement,
  expandBtn: HTMLElement,
  collapseBtn: HTMLElement,
): void {
  expandBtn.addEventListener('click', () => expandAll(root));
  collapseBtn.addEventListener('click', () => {
    for (const node of root.querySelectorAll('details')) node.open = false;
  });
}
