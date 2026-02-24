// ── Welcome screen ────────────────────────────────────────────────────────────
// Guards against regressions where stale HTML (e.g. leftover vanilla-JS markup)
// creates duplicate DOM elements that block React from working correctly.

import { test, expect } from '@playwright/test';

test.describe('Welcome screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders exactly one welcome screen element', async ({ page }) => {
    // Regression: index.html once had duplicate <body> content, producing two
    // #welcome-screen divs. The second (static) one sat on top of React's version
    // with no event listeners, so clicks did nothing.
    await expect(page.locator('#welcome-screen')).toHaveCount(1);
    await expect(page.locator('#welcome-screen')).toBeVisible();
  });

  test('renders exactly one #app root', async ({ page }) => {
    await expect(page.locator('#app')).toHaveCount(1);
  });

  test('demo mode button is visible and labelled correctly', async ({ page }) => {
    await expect(page.locator('#demo-mode-btn')).toBeVisible();
    await expect(page.locator('#demo-mode-btn')).toContainText('Enter Demo Mode');
  });

  test('canvas and header are hidden before any data arrives', async ({ page }) => {
    // The no-data CSS class hides diagram elements until data is present.
    await expect(page.locator('#main-canvas')).not.toBeVisible();
    await expect(page.locator('#header')).not.toBeVisible();
  });
});
