import {test,expect} from '@playwright/test';
import {mockApprovedSession} from './approved-session.js';

test('tablet fit and 100% keep the logical viewport and manuscript font unchanged',async ({page}) => {
  await mockApprovedSession(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
  await page.locator('.new-book').click(); await page.locator('#add').click();
  await page.locator('#tabletPreview').selectOption('ipad');
  const frame = page.locator('.preview-isolated-frame');
  const preview = page.locator('#preview');
  const fit = await preview.evaluate(element => ({width:getComputedStyle(element).width,transform:getComputedStyle(element).transform}));
  expect(fit.width).toBe('820px');
  const fitScale = Number(fit.transform.match(/^matrix\(([^,]+)/)?.[1] || 1);
  expect(fitScale).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button',{name:'맞춤',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'100%'}).click();
  await expect(preview).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await expect.poll(() => page.locator('.preview-stage').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(page.frameLocator('.preview-isolated-frame').locator('body')).toHaveCSS('font-size','20px');
  await page.getByRole('button',{name:'맞춤',exact:true}).click();
  await expect(page.getByRole('button',{name:'맞춤',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(await preview.evaluate(element => getComputedStyle(element).width)).toBe('820px');
  await page.locator('#tabletPreview').selectOption('');
  await expect(page.getByRole('button',{name:'100%'})).toBeHidden();
  await expect(frame).toBeAttached();
});
