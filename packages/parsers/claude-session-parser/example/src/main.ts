import { parseSessionTranscript } from '@lucasschirm/sal-claude-session-parser';
import './style.css';
import { bindJsonControls, renderJsonTree } from './json-view';
import { renderPretty } from './pretty';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

const dropzone = $('dropzone');
const fileInput = $('file-input') as HTMLInputElement;
const fileName = $('file-name');
const errorAlert = $('error-alert');
const errorText = $('error-text');
const results = $('results');
const prettyView = $('pretty-view');
const jsonView = $('json-view');
const jsonTree = $('json-tree');
const tabPretty = $('tab-pretty');
const tabJson = $('tab-json');

bindJsonControls(jsonTree, $('json-expand'), $('json-collapse'));

function selectTab(json: boolean): void {
  tabPretty.classList.toggle('tab-active', !json);
  tabJson.classList.toggle('tab-active', json);
  prettyView.classList.toggle('hidden', json);
  jsonView.classList.toggle('hidden', !json);
}

tabPretty.addEventListener('click', () => selectTab(false));
tabJson.addEventListener('click', () => selectTab(true));

async function handleFile(file: File): Promise<void> {
  errorAlert.classList.add('hidden');
  try {
    const content = await file.text();
    const session = parseSessionTranscript(content);
    fileName.textContent = `${file.name} — ${session.entries.length.toLocaleString('en-US')} entries parsed`;
    fileName.classList.remove('hidden');
    prettyView.innerHTML = renderPretty(session, file.name);
    renderJsonTree(session, jsonTree);
    selectTab(false);
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    errorText.textContent = `Failed to parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
    errorAlert.classList.remove('hidden');
  }
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
  fileInput.value = '';
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('border-primary', 'bg-base-300');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('border-primary', 'bg-base-300');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('border-primary', 'bg-base-300');
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});
