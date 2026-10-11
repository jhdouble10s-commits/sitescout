import { test, expect } from '@playwright/test';
import { setTheme, openApiSettings } from './ui-helpers.js';
import { mockApprovedSession } from './approved-session.js';

async function start(page) {
  await mockApprovedSession(page);
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await expect(page.locator('.sb-header')).toBeAttached({timeout:30000});
  await page.waitForFunction(() => Boolean(window.epubMonacoEditor));
}

async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => ({
    document:document.documentElement.scrollWidth - innerWidth,
    main:document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth,
  }))).toEqual({document:0, main:0});
}

async function previewFits(page) {
  await expect(page.locator('#preview')).toHaveAttribute('data-device-preview','true');
  await expect.poll(async () => {
    const frame = await page.locator('#preview').boundingBox();
    const stage = await page.locator('.preview-stage').boundingBox();
    return frame.width > 0 && frame.height > 0 && frame.x >= stage.x - 1 &&
      frame.x + frame.width <= stage.x + stage.width + 1 &&
      frame.y + frame.height <= stage.y + stage.height + 1;
  }).toBe(true);
}

test('sidebar 240/56px, icon labels, persisted layout, themes, and editor resize preserve content', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.locator('#title').fill('사이드바 저장 회귀 테스트');
  await page.locator('#add').click();
  await page.locator('[data-mode-toggle]').click();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p id="kept">사이드바 전환에도 원문 유지<br /></p>'));
  const selected = await page.locator('#list .chapter.active').getAttribute('data-chapter-id');
  const original = await page.evaluate(() => window.epubMonacoEditor.getValue());
  const side = page.locator('#app-sidebar');
  await expect.poll(async () => (await side.boundingBox()).width).toBe(240);
  const initialWidth = (await page.locator('main').boundingBox()).width;
  await page.locator('#phonePreview').selectOption('iphone-16');
  await previewFits(page);
  await noHorizontalOverflow(page);
  await page.locator('#tabletPreview').selectOption('ipad');
  await previewFits(page);
  await page.screenshot({path:test.info().outputPath('sidebar-expanded-dark.png')});
  const brandMark = await side.locator('.sb-brand-mark').boundingBox();
  await page.getByRole('button', {name:'사이드바 접기', exact:true}).click();
  await expect.poll(async () => (await side.boundingBox()).width).toBe(56);
  expect((await page.locator('main').boundingBox()).width).toBe(initialWidth + 184);
  await expect(side.locator('.sb-label:visible')).toHaveCount(0);
  await expect(side.locator('.sb-brand')).toBeHidden();
  const collapsedToggle = await side.locator('.sidebar-toggle').boundingBox();
  expect(Math.abs((collapsedToggle.x + collapsedToggle.width / 2) - (brandMark.x + brandMark.width / 2))).toBeLessThanOrEqual(3);
  await expect(side.locator('.sb-submenu')).not.toBeVisible();
  for (const button of await side.locator('button.sb-menu-button:visible').all()) {
    await expect(button).toHaveAttribute('title', /.+/);
    await expect(button).toHaveAttribute('aria-label', /.+/);
  }
  await expect(side.locator('summary[data-active="true"]')).toBeVisible();
  const viewportWidth = await page.locator('#xhtml-monaco-editor').evaluate(el => el.clientWidth);
  await expect.poll(() => page.evaluate(() => window.epubMonacoEditor.getLayoutInfo().width)).toBe(viewportWidth);
  await expect(page.locator('#list .chapter.active')).toHaveAttribute('data-chapter-id', selected);
  expect(await page.evaluate(() => window.epubMonacoEditor.getValue())).toBe(original);
  await noHorizontalOverflow(page);
  await previewFits(page);
  await page.screenshot({path:test.info().outputPath('sidebar-collapsed-dark.png')});
  await setTheme(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  await page.waitForTimeout(500);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('region',{name:'프로젝트 선택'})
    .getByRole('button',{name:'사이드바 저장 회귀 테스트'}).click();
  await expect(page.locator('#app-sidebar')).toHaveAttribute('data-state', 'collapsed');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.waitForFunction(() => Boolean(window.epubMonacoEditor));
  await expect.poll(() => page.evaluate(() => window.epubMonacoEditor.getValue())).toContain('사이드바 전환에도 원문 유지');
  // The collapsed parent opens the sidebar and its children, without a flyout.
  await side.locator('summary').click();
  await expect(side).toHaveAttribute('data-state', 'expanded');
  await expect(side.locator('.sb-submenu')).toBeVisible();
  await page.screenshot({path:test.info().outputPath('sidebar-expanded-light.png')});
  await page.locator('.epub-file-actions .new-book').click();
  await expect(page.locator('#title')).toHaveValue('');
  await side.locator('.tab[data-view="editorView"]').click();
  await side.locator('.draft-item').filter({hasText:'사이드바 저장 회귀 테스트'}).click();
  const leaveDialog=page.getByRole('dialog',{name:'미저장 변경 이탈 확인'});
  if (await leaveDialog.isVisible()) await leaveDialog.getByRole('button',{name:'변경 버리고 이동'}).click();
  await expect(page.locator('#title')).toHaveValue('사이드바 저장 회귀 테스트');
  await expect(page.frameLocator('.preview-isolated-frame').locator('body')).toContainText('사이드바 전환에도 원문 유지');
  expect(errors).toEqual([]);
});

test('sidebar menus delegate to original controls, native submenu keyboard, import/export and settings remain connected', async ({page}) => {
  await start(page);
  const side = page.locator('#app-sidebar');
  await page.evaluate(() => {
    window.panelClicks = 0;
    document.querySelector('.left-tab[data-panel="assetsPanel"]').addEventListener('click', () => window.panelClicks++);
  });
  await page.locator('.left-tab[data-panel="assetsPanel"]').click();
  await expect(page.locator('#assetsPanel')).toHaveClass(/active/);
  await expect(page.locator('.left-tab[data-panel="assetsPanel"]')).toHaveClass(/active/);
  expect(await page.evaluate(() => window.panelClicks)).toBe(1);
  await page.locator('.left-tab[data-panel="cssPanel"]').click();
  await expect(page.locator('#cssPanel')).toHaveClass(/active/);
  await page.locator('.left-tab[data-panel="chaptersPanel"]').click();
  await expect(page.locator('.left-tab[data-panel="chaptersPanel"]')).toHaveClass(/active/);
  await expect(page.locator('.left-tab[data-panel="cssPanel"]')).not.toHaveClass(/active/);
  await side.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(side.locator('details')).not.toHaveAttribute('open');
  await page.keyboard.press('Space');
  await expect(side.locator('details')).toHaveAttribute('open');
  await page.locator('#title').click();
  await expect(page.locator('#title')).toBeFocused();
  await side.locator('.tab[data-view="editorView"]').click();
  await expect(side.locator('.drafts-empty')).toBeVisible();
  await openApiSettings(page);
  await expect(page.locator('dialog').filter({has:page.locator('input[name="apiKey"]')})).toBeVisible();
  await page.keyboard.press('Escape');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', {name:'불러오기', exact:true}).click();
  const chooser = await chooserPromise;
  page.once('dialog', dialog => dialog.accept());
  await chooser.setFiles('기도먼저.epub');
  await expect(page.locator('#status')).toContainText('불러왔', {timeout:30000});
  // Import selects the first body chapter. Select the cover explicitly before
  // testing its resource-backed view; do not assume a spine index is a cover.
  await page.locator('#list .cover-chapter').click({position:{x:55,y:15}});
  await expect(page.locator('#preview img')).toHaveCount(1);
  await expect(page.locator('#preview img')).toHaveAttribute('src', /^blob:/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.epub-file-actions #export').click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.epub$/);
  await page.locator('.epub-file-actions .new-book').click();
  await expect(page.locator('#title')).toHaveValue('');
  await expect(page.locator('#list .chapter')).toHaveCount(2);
  // Inspect the existing account route without sending credentials or signing out.
  await page.route('**/login/', route => route.fulfill({body:'login route fixture'}));
  await side.locator('.account-button').click();
  await expect(page).toHaveURL(/\/login\/\?reason=login$/);
});

test('device preview fits its CSS viewport without zoom controls and uses a 20px base font', async ({page}) => {
  await start(page);
  await expect(page.locator('[data-preview-fit], [data-preview-actual], [data-preview-scale], [data-preview-scale-value]')).toHaveCount(0);
  await page.locator('#add').click();
  await expect.poll(() => page.frameLocator('.preview-isolated-frame').locator('body').evaluate(body => getComputedStyle(body).fontSize)).toBe('20px');
  await page.locator('#phonePreview').selectOption('iphone-16');
  await expect(page.locator('#preview')).toHaveAttribute('style',/width: 393px/);
  await expect(page.locator('#preview')).toHaveAttribute('style',/height: 852px/);
  const scale = await page.locator('#preview').evaluate(element => Number(element.style.transform.match(/scale\(([^)]+)\)/)?.[1]));
  expect(scale).toBeGreaterThan(0);
  expect(scale).toBeLessThanOrEqual(1);
  await previewFits(page);
  await page.locator('#tabletPreview').selectOption('ipad');
  await expect(page.locator('#preview')).toHaveAttribute('style',/width: 820px/);
  await previewFits(page);
  await page.locator('#phonePreview').selectOption('');
  await page.locator('#tabletPreview').selectOption('');
  await expect(page.locator('#preview')).toHaveAttribute('data-device-preview','false');
  const bottoms = await page.evaluate(() => ['.editor','.preview-card'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect(); return Math.round(rect.bottom);
  }));
  expect(Math.abs(bottoms[0] - bottoms[1])).toBeLessThanOrEqual(1);
});

test('mobile native drawer traps focus, closes by Escape/backdrop/action and returns to desktop without duplicates', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await start(page);
  const trigger = page.getByRole('button', {name:'메뉴 열기', exact:true});
  const drawer = page.locator('.sb-drawer');
  await expect(trigger).toBeVisible();
  await expect(page.locator('#app-sidebar')).not.toBeVisible();
  await noHorizontalOverflow(page);
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('.sb-drawer').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(370,400);
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await page.screenshot({path:test.info().outputPath('sidebar-mobile.png')});
  await drawer.locator('.settings-button').click();
  await expect(drawer).not.toBeVisible();
  await expect(page.locator('.app-settings-dialog')).toBeVisible();
  await page.locator('.app-settings-dialog .api-settings-button').click();
  await expect(page.locator('dialog').filter({has:page.locator('input[name="apiKey"]')})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:900,height:900});
  await expect(page.locator('.app > #app-sidebar')).toHaveAttribute('data-state','collapsed');
  await expect.poll(async () => (await page.locator('#app-sidebar').boundingBox()).width).toBe(56);
  await noHorizontalOverflow(page);
  await page.setViewportSize({width:1600,height:1000});
  await expect(page.locator('.app > #app-sidebar')).toBeVisible();
  await expect(page.locator('#app-sidebar')).toHaveCount(1);
  await expect(page.locator('.sidebar-toggle')).toHaveCount(1);
  await expect(page.locator('#export')).toHaveCount(1);
  await expect(trigger).not.toBeVisible();
  await noHorizontalOverflow(page);
});
