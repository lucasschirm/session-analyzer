import { expect, type Page, test } from '@playwright/test';

/**
 * Create a project through the home-page modal.
 *
 * Reuses the same flow as app.spec.ts so the test can drive the real delete
 * entry point. The project name is also the visible card text the assertions
 * below target.
 */
async function createProject(page: Page, name: string, description = ''): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New Project' }).click();
  await page.locator('#project-name-input').fill(name);
  if (description) {
    await page.locator('#project-description-input').fill(description);
  }
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();
}

test.describe('UX-015: delete confirmation focus/keyboard contract', () => {
  test('traps focus, cancels on Escape, and returns focus to the trigger', async ({ page }) => {
    const projectName = 'UX-015 Focus Project';
    await createProject(page, projectName);

    const card = page.locator('.project-card', { hasText: projectName });
    const trigger = card.getByRole('button', { name: 'Delete Project' });

    // Open the delete confirmation dialog via its normal UI trigger.
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Delete project?' });
    await expect(dialog).toBeVisible();

    // Focus must move into the dialog and land on the first focusable control.
    const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
    const confirmButton = dialog.getByRole('button', { name: 'Delete Project' });
    await expect(cancelButton).toBeFocused({ timeout: 5000 });

    // Tab must cycle within the dialog (focus trap).
    await page.keyboard.press('Tab');
    await expect(confirmButton).toBeFocused({ timeout: 5000 });

    await page.keyboard.press('Tab');
    await expect(cancelButton).toBeFocused({ timeout: 5000 });

    // Shift+Tab must cycle backward within the dialog.
    await page.keyboard.press('Shift+Tab');
    await expect(confirmButton).toBeFocused({ timeout: 5000 });

    // Escape must close the dialog without confirming the destructive action.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(card).toBeVisible();

    // Focus must return to the element that opened the dialog.
    await expect(trigger).toBeFocused({ timeout: 5000 });

    // The destructive action must only occur on explicit confirm.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete Project' }).click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(page.locator('.project-card')).toHaveCount(0);
    await expect(page.getByText('No projects yet')).toBeVisible();
  });
});
