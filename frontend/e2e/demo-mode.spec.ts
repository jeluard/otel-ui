// ── Demo mode ─────────────────────────────────────────────────────────────────
// Verifies the full demo mode activation / deactivation lifecycle.

import { test, expect } from '@playwright/test';

test.describe('Demo mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#demo-mode-btn')).toBeVisible();
  });

  test('clicking demo button hides the welcome screen', async ({ page }) => {
    await page.click('#demo-mode-btn');
    await expect(page.locator('#welcome-screen')).not.toBeVisible();
  });

  test('clicking demo button reveals the canvas', async ({ page }) => {
    await page.click('#demo-mode-btn');
    await expect(page.locator('#main-canvas')).toBeVisible();
  });

  test('clicking demo button reveals the header', async ({ page }) => {
    await page.click('#demo-mode-btn');
    await expect(page.locator('#header')).toBeVisible();
  });

  test('demo banner appears in header with exit button', async ({ page }) => {
    await page.click('#demo-mode-btn');
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('#demo-banner')).toContainText('Demo mode');
    await expect(page.locator('#demo-banner button')).toBeVisible();
  });

  test('exit demo button returns to welcome screen', async ({ page }) => {
    await page.click('#demo-mode-btn');
    await expect(page.locator('#demo-banner')).toBeVisible();

    await page.click('#demo-banner button');

    await expect(page.locator('#welcome-screen')).toBeVisible();
    await expect(page.locator('#main-canvas')).not.toBeVisible();
    await expect(page.locator('#header')).not.toBeVisible();
  });

  test('demo data populates the diagram within a few seconds', async ({ page }) => {
    await page.click('#demo-mode-btn');
    // The layout canvas should receive nodes from the topology snapshot
    // and start rendering. Wait for the minimap to become non-zero opacity,
    // which the renderer sets once nodes are present.
    await page.waitForFunction(
      () => {
        const mm = document.getElementById('minimap') as HTMLCanvasElement | null;
        return mm && parseFloat(mm.style.opacity ?? '1') > 0;
      },
      { timeout: 5000 },
    );
  });
});
