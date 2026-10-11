import {test,expect} from '@playwright/test';
import {mockApprovedSession} from './approved-session.js';

test('Monaco input keeps its own box model and visible host focus during Korean composition',async ({page}) => {
  await mockApprovedSession(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
  await page.locator('.new-book').click(); await page.locator('#add').click();
  if (await page.locator('[data-mode-toggle]').textContent() === 'XHTML편집') await page.locator('[data-mode-toggle]').click();
  await page.evaluate(() => {window.epubMonacoEditor.setValue('<p>한글</p>');window.epubMonacoEditor.focus();});
  const input = page.locator('#xhtml-monaco-editor textarea.inputarea');
  await expect(input).toBeFocused();
  const box = await input.evaluate(element => {
    const style = getComputedStyle(element);
    return {padding:style.paddingTop,border:style.borderTopWidth,shadow:style.boxShadow};
  });
  expect(box.padding).toBe('0px');
  expect(box.border).toBe('0px');
  expect(box.shadow).toBe('none');
  await expect(page.locator('#xhtml-monaco-editor')).toHaveCSS('outline-style','solid');
  const lineTop = await page.locator('#xhtml-monaco-editor .view-line').first().evaluate(element => element.getBoundingClientRect().top);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
  await cdp.send('Input.insertText',{text:'한글'});
  await expect(page.locator('#body')).toHaveValue(/한글/);
  const afterCompositionTop = await page.locator('#xhtml-monaco-editor .view-line').first().evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(afterCompositionTop - lineTop)).toBeLessThan(1);
  await cdp.detach();
});
