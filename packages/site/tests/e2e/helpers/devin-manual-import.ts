import { expect, type Page } from '@playwright/test';
import { type DevinFileSpec, devinLinearFiles } from './devin-fixtures.js';

export interface ManualImportSelectionSpec {
  readonly file: DevinFileSpec;
  readonly relativePath: string;
}

/**
 * Drive the Manual Import page with a controlled Devin bundle upload.
 *
 * This bypasses the file picker and the upload zone by dispatching the
 * `manual-files-selected` CustomEvent directly on `<manual-import-upload>`.
 * That keeps the directory-relative paths (`native/...`) intact, which the
 * Devin transformer requires to classify sidecar artifacts.
 */
export async function uploadDevinBundleToManualImport(page: Page): Promise<void> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible({
    timeout: 15000,
  });

  const files = devinLinearFiles();

  await page.evaluate<void, DevinFileSpec[]>((fileSpecs) => {
    function findInShadows(
      root: Document | ShadowRoot | Element,
      selector: string,
    ): Element | null {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const host of root.querySelectorAll('*')) {
        const el = host as HTMLElement & { shadowRoot?: ShadowRoot | null };
        if (el.shadowRoot) {
          const inner = findInShadows(el.shadowRoot, selector);
          if (inner) return inner;
        }
      }
      return null;
    }

    const upload = findInShadows(document, 'manual-import-upload') as HTMLElement | null;
    if (!upload) {
      throw new Error('manual-import-upload not found');
    }

    const detailFiles = fileSpecs.map((spec) => ({
      file: new File([spec.content], spec.name, { type: spec.mediaType }),
      relativePath: spec.relativePath,
    }));

    upload.dispatchEvent(
      new CustomEvent('manual-files-selected', {
        detail: { files: detailFiles, pathPreserved: true },
        bubbles: true,
        composed: true,
      }),
    );
  }, files);
}

/**
 * Complete the manual import flow for the pre-uploaded Devin bundle.
 *
 * Waits for harness detection to finish, chooses a new project, optionally
 * overrides the session id, clicks Import, and waits for the `View session`
 * button. Returns the canonical analytics session id from the receipt.
 */
export async function importDevinSession(
  page: Page,
  projectName: string,
  sessionId?: string,
): Promise<string> {
  await uploadDevinBundleToManualImport(page);

  // Wait for the Devin harness detection to surface in the harness selector.
  await expect(page.getByText('Detected harness: devin')).toBeVisible({
    timeout: 15000,
  });

  // Use a new project for a clean, deterministic session identity.
  await page.locator('#project-select').selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  if (sessionId) {
    await sessionInput.fill(sessionId);
  }
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();

  const viewButton = page.getByRole('button', { name: 'View session' });
  await expect(viewButton).toBeVisible({ timeout: 30000 });

  // Extract the canonical session id from the page state. The receipt is
  // bound to the manual-import-state element; read it from the host property.
  const receipt = await page
    .locator('manual-import-page')
    .first()
    .evaluate((el) => {
      const host = el as unknown as { receipt?: { sessionId: string } | null };
      return host.receipt;
    });

  await viewButton.click();
  await expect(page).toHaveURL(/#\/sessions\//, { timeout: 15000 });

  return receipt?.sessionId ?? '';
}

/**
 * Navigate to the Session Evidence view for the given session id.
 */
export async function openDevinSessionEvidence(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/#/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByText(/Session Evidence —/)).toBeVisible({ timeout: 15000 });
}

/**
 * Switch the Session Evidence view tab without relying on the `<a>` click.
 *
 * The hash router strips query parameters from the hash on `hashchange`, so
 * `?view=transcript` set by the tab's `@click` handler is lost before the
 * view can observe it. This helper mutates the component's `params.view`
 * directly and awaits re-render.
 */
export async function switchSessionEvidenceTab(
  page: Page,
  view: 'evidence' | 'transcript',
): Promise<void> {
  await page.evaluate<string | undefined, 'evidence' | 'transcript'>(async (targetView) => {
    function findInShadows(
      root: Document | ShadowRoot | Element,
      selector: string,
    ): Element | null {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const host of root.querySelectorAll('*')) {
        const el = host as HTMLElement & { shadowRoot?: ShadowRoot | null };
        if (el.shadowRoot) {
          const inner = findInShadows(el.shadowRoot, selector);
          if (inner) return inner;
        }
      }
      return null;
    }

    const viewEl = findInShadows(document, 'session-evidence-view') as
      | (HTMLElement & {
          params?: { view?: string };
          requestUpdate?: () => void;
          updateComplete?: Promise<void>;
        })
      | null;
    if (!viewEl) throw new Error('session-evidence-view not found');

    viewEl.params = { ...viewEl.params, view: targetView };
    if (typeof viewEl.requestUpdate === 'function') {
      viewEl.requestUpdate();
    }
    if (viewEl.updateComplete) {
      await viewEl.updateComplete;
    }
    return viewEl.params.view;
  }, view);
}
