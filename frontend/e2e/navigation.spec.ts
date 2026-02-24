// ── Tab navigation ────────────────────────────────────────────────────────────
// Verifies that the three main tabs switch views correctly.

import { test, expect } from '@playwright/test';

test.describe('Tab navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Enter demo mode so the header and tabs are visible
    await page.click('#demo-mode-btn');
    await expect(page.locator('#header')).toBeVisible();
  });

  test('Spans tab shows the spans view and hides the canvas', async ({ page }) => {
    await page.click('button.tab-btn:has-text("Spans")');
    await expect(page.locator('#spans-view')).toBeVisible();
    await expect(page.locator('#main-canvas')).not.toBeVisible();
  });

  test('Traces tab shows the traces view', async ({ page }) => {
    await page.click('button.tab-btn:has-text("Traces")');
    await expect(page.locator('#traces-view')).toBeVisible();
    await expect(page.locator('#main-canvas')).not.toBeVisible();
  });

  test('Diagram tab restores canvas after switching away', async ({ page }) => {
    await page.click('button.tab-btn:has-text("Spans")');
    await page.click('button.tab-btn:has-text("Diagram")');
    await expect(page.locator('#main-canvas')).toBeVisible();
    await expect(page.locator('#spans-view')).not.toBeVisible();
  });

  test('active tab button has the tab-active class', async ({ page }) => {
    await page.click('button.tab-btn:has-text("Spans")');
    await expect(page.locator('button.tab-btn:has-text("Spans")')).toHaveClass(/tab-active/);
    await expect(page.locator('button.tab-btn:has-text("Diagram")')).not.toHaveClass(/tab-active/);
  });
});
