import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { mockApprovedSession, openSavedServerProject } from './approved-session.js';

async function start(page,source) {
  await mockApprovedSession(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
  await page.locator('.new-book').click(); await page.locator('#add').click();
  await page.locator('#title').fill('편집 도구 회귀');
  await page.locator('[data-mode-toggle]').click();
  await page.evaluate(value => window.epubMonacoEditor.setValue(value),source);
  await page.locator('[data-mode-toggle]').click();
}
const source = page => page.evaluate(() => window.epubMonacoEditor.getValue());
async function tool(page,name) { await page.getByRole('button',{name,exact:true}).click(); }
async function table(page,name) {
  if (!await page.locator('.editor-tools-table:popover-open').count()) await tool(page,'표 편집');
  await tool(page,name);
}

test('unsupported XHTML stays read-only; clear formatting still supports safe content and undo',async ({page}) => {
  await start(page,'<h2 id="keep" class="chapter"><strong>Alpha</strong> <a href="#keep" epub:type="noteref">1</a> <span id="anchor" style="color:red;font-size:24px">Beta</span></h2>');
  const original = await source(page);
  await expect(page.locator('.visual-read-only-notice')).toBeVisible();
  await page.locator('.ProseMirror').click(); await page.keyboard.type('cannot change source');
  expect(await source(page)).toBe(original);
  await page.locator('[data-mode-toggle]').click();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p><strong>Alpha</strong> <em>Beta</em></p>'));
  await page.locator('[data-mode-toggle]').click();
  await expect(page.locator('.visual-read-only-notice')).toBeHidden();
  await page.locator('.ProseMirror').click(); await page.keyboard.press('ControlOrMeta+a');
  await tool(page,'서식 지우기 (글자 서식)');
  await expect(page.locator('.ProseMirror strong')).toHaveCount(0);
  await tool(page,'되돌리기 (Ctrl/Cmd+Z)');
  await expect(page.locator('.ProseMirror strong')).toHaveText('Alpha');
});

test('table controls use selection, support row/column deletion and undo',async ({page}) => {
  await start(page,'<p id="keep">Before</p>');
  await page.locator('.ProseMirror p').click(); await page.keyboard.press('End');
  await table(page,'2×2 표 삽입');
  await expect(page.locator('.ProseMirror tr')).toHaveCount(2);
  await table(page,'아래에 행 추가');
  await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
  await table(page,'오른쪽에 열 추가');
  await expect(page.locator('.ProseMirror tr').first().locator('th,td')).toHaveCount(3);
  await page.locator('.ProseMirror th').first().click();
  await tool(page,'표 편집');
  await page.locator('[data-table-color="head"]').evaluate(input => { input.value='#123456'; input.dispatchEvent(new Event('input',{bubbles:true})); });
  await expect(page.frameLocator('.preview-isolated-frame').locator('th').first()).toHaveCSS('background-color','rgb(18, 52, 86)');
  expect(await source(page)).toContain('background-color: rgb(18, 52, 86)');
  await page.keyboard.press('Escape');
  await table(page,'열 삭제');
  await expect(page.locator('.ProseMirror tr').first().locator('th,td')).toHaveCount(2);
  await table(page,'행 삭제');
  await expect(page.locator('.ProseMirror tr')).toHaveCount(2);
  await tool(page,'되돌리기 (Ctrl/Cmd+Z)');
  await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
  await expect(page.locator('.ProseMirror #keep')).toHaveText('Before');
  await table(page,'표 삭제');
  await expect(page.locator('.ProseMirror table')).toHaveCount(0);
  await tool(page,'표 편집');
  await expect(page.getByRole('button',{name:'행 삭제',exact:true})).toBeDisabled();
});

test('Ctrl+F searches text across marks, replaces safely, undo, chapter/mode isolation',async ({page}) => {
  await start(page,'<p id="Alpha"><strong>Al</strong>pha Alpha <a href="Alpha.xhtml#Alpha">link</a></p>');
  await page.locator('.ProseMirror').click(); await page.keyboard.press('ControlOrMeta+f');
  const dialog = page.getByRole('dialog',{name:'현재 장 찾기 및 바꾸기'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox',{name:'찾을 내용',exact:true}).fill('Alpha');
  await expect(dialog.locator('output')).toHaveText('2개 일치');
  await dialog.getByRole('textbox',{name:'바꿀 내용',exact:true}).fill('Beta');
  await tool(page,'현재 장 모두 바꾸기');
  await expect(page.locator('.ProseMirror #Alpha')).toHaveText('Beta Beta link');
  await expect(page.locator('.ProseMirror a')).toHaveAttribute('href','Alpha.xhtml#Alpha');
  await tool(page,'찾기 닫기');
  expect(await source(page)).not.toContain('search-match');
  await tool(page,'되돌리기 (Ctrl/Cmd+Z)');
  await expect(page.locator('.ProseMirror #Alpha')).toHaveText('Alpha Alpha link');
  await tool(page,'찾기 및 바꾸기 (Ctrl+F)');
  await tool(page,'다음 결과');
  await tool(page,'현재 항목 바꾸기');
  await expect(page.locator('.ProseMirror #Alpha')).toHaveText(/Beta Alpha link|Alpha Beta link/);
  await expect(dialog.locator('output')).toHaveText('1개 일치');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.locator('.ProseMirror').click(); await page.keyboard.press('ControlOrMeta+f');
  await page.locator('#add').click();
  await expect(dialog).toBeHidden();
  await page.locator('[data-mode-toggle]').click();
  await page.evaluate(() => window.epubMonacoEditor.focus());
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#xhtml-monaco-editor .find-widget')).toBeVisible();
});

test('search decorations clear on empty query, close, and chapter change without removing manuscript marks',async ({page}) => {
  await start(page,'<p><strong>Alpha</strong> Alpha</p>');
  const original = await source(page);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+f');
  const dialog = page.getByRole('dialog',{name:'현재 장 찾기 및 바꾸기'});
  const query = dialog.getByRole('textbox',{name:'찾을 내용',exact:true});
  await query.fill('Alpha');
  await expect(page.locator('.ProseMirror-search-match, .ProseMirror-active-search-match')).toHaveCount(2);
  await query.fill('');
  await expect(page.locator('.ProseMirror-search-match, .ProseMirror-active-search-match')).toHaveCount(0);
  await expect(page.frameLocator('.preview-isolated-frame').locator('mark.preview-context')).toHaveCount(0);
  await query.fill('Alpha');
  await tool(page,'찾기 닫기');
  await expect(page.locator('.ProseMirror-search-match, .ProseMirror-active-search-match')).toHaveCount(0);
  await page.locator('.ProseMirror').click(); await page.keyboard.press('ControlOrMeta+f');
  await query.fill('Alpha');
  await page.locator('#add').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.ProseMirror-search-match, .ProseMirror-active-search-match')).toHaveCount(0);
  expect(original).toContain('<strong>Alpha</strong>');
  await page.locator('[data-mode-toggle]').click();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p><mark id="original-mark">Alpha</mark></p>'));
  await page.locator('[data-mode-toggle]').click();
  await expect(page.frameLocator('.preview-isolated-frame').locator('mark#original-mark')).toHaveText('Alpha');
  expect(await source(page)).toContain('<mark id="original-mark">Alpha</mark>');
});

test('imported table attributes remain intact in visual read-only mode',async ({page}) => {
  await start(page,'<p><strong>Alpha Beta</strong></p><table id="data" class="original"><tbody><tr id="row"><td id="cell"><p>A</p></td><td><p>B</p></td></tr></tbody></table>');
  const before = await source(page);
  await expect(page.locator('.visual-read-only-notice')).toBeVisible();
  await page.locator('.ProseMirror strong').click(); await page.keyboard.type('blocked');
  expect(await source(page)).toBe(before);
  expect(before).toContain('table id="data" class="original"');
  expect(before).toContain('tr id="row"');
  await page.locator('[data-mode-toggle]').click();
  expect(await source(page)).toBe(before);
});

test('first-line and paragraph indentation preserve tags/classes/CSS and EPUB round-trip',async ({page}) => {
  await start(page,'<h2 id="first" class="original">Title</h2><p id="second">Body</p>');
  const css = '/* USER */\n.original { color: #222; }\n';
  await page.evaluate(css => window.epubCssMonacoEditor.setValue(css),css);
  await page.locator('.ProseMirror #first').click();
  await tool(page,'첫 줄 들여쓰기 켜기/끄기');
  await tool(page,'단락 전체 들여쓰기'); await tool(page,'단락 전체 들여쓰기');
  await expect(page.locator('.ProseMirror h2#first')).toHaveClass('original jh-first-line-indent jh-paragraph-indent-2');
  await expect(page.locator('.ProseMirror #second')).not.toHaveAttribute('class');
  expect(await page.frameLocator('.preview-isolated-frame').locator('#first').evaluate(node => parseFloat(getComputedStyle(node).textIndent))).toBeGreaterThan(0);
  await tool(page,'단락 전체 내어쓰기');
  await expect(page.locator('.ProseMirror h2#first')).toHaveClass('original jh-first-line-indent jh-paragraph-indent-1');
  const savedCss = await page.locator('#css').inputValue();
  expect(savedCss.startsWith(css)).toBe(true);
  expect(savedCss.match(/\.jh-first-line-indent/g)).toHaveLength(1);
  await page.locator('.draft-save').click();
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
  await openSavedServerProject(page,'편집 도구 회귀');
  expect(await source(page)).toContain('jh-first-line-indent');
  await expect(page.locator('#css')).toHaveValue(savedCss);
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloading;
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  expect(await zip.file('EPUB/styles/book.css').async('string')).toBe(savedCss);
  const xhtml = (await Promise.all(Object.values(zip.files).filter(file => file.name.endsWith('.xhtml')).map(file => file.async('string')))).join('');
  expect(xhtml).toContain('jh-paragraph-indent-1');
  await page.locator('input[type=file][accept^=".epub"]').setInputFiles(await download.path());
  const leaveImport=page.getByRole('dialog',{name:'미저장 변경 이탈 확인'});
  await expect.poll(async () => await leaveImport.isVisible() || (await page.locator('#status').textContent())?.includes('불러왔')).toBe(true);
  if (await leaveImport.isVisible()) await leaveImport.getByRole('button',{name:'변경 버리고 이동'}).click();
  await expect(page.locator('#status')).toContainText('불러왔');
  await expect(page.locator('#css')).toHaveValue(savedCss);
});

test('text style marks survive a visual/XHTML round trip and resetting the font keeps size and colour',async ({page}) => {
  await start(page,'<p>Alpha Beta</p>');
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  const size = page.locator('[data-font-size]');
  await size.fill('24');
  await size.press('Enter');
  await page.getByLabel('글자색').evaluate(input => {
    input.value = '#123456';
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.locator('[data-font-family]').selectOption('serif');
  await page.locator('[data-font-family]').selectOption('');
  await page.locator('[data-mode-toggle]').click();
  const after = await source(page);
  expect(after).toContain('font-size: 24px');
  expect(after).toContain('color: rgb(18, 52, 86)');
  expect((after.match(/<span\b/g) || []).length).toBe(1);
  await page.locator('[data-mode-toggle]').click();
  await expect(page.locator('.visual-read-only-notice')).toBeHidden();
  await expect(editor).toContainText('Alpha Beta');
});

test('quote, Roman list and toolbar active state use the Tiptap selection',async ({page}) => {
  await start(page,'<p>Alpha</p><ol><li>One</li></ol>');
  await page.locator('.ProseMirror > p').click();
  await tool(page,'인용');
  await expect(page.locator('.ProseMirror blockquote')).toContainText('Alpha');
  await page.locator('.ProseMirror li').click();
  await page.locator('[data-list]').selectOption('upper-roman');
  await expect(page.locator('.ProseMirror > ol')).toHaveCSS('list-style-type','upper-roman');
  await page.locator('.ProseMirror blockquote').click();
  await page.keyboard.press('ControlOrMeta+a');
  await tool(page,'굵게');
  await expect(page.locator('[data-command="bold"]')).toHaveClass(/active/);
});

test('the visual host has one editable document and keeps the ProseMirror selection after an explicit save',async ({page}) => {
  await start(page,'<p>Alpha Beta</p>');
  await expect(page.locator('.rich-editor')).not.toHaveAttribute('contenteditable');
  const paragraph = page.locator('.ProseMirror p');
  await paragraph.click();
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft');
  await page.locator('.draft-save').click();
  await expect(page.locator('.draft-save')).toBeEnabled();
  await tool(page,'굵게');
  await expect(page.locator('.ProseMirror strong')).toHaveText('Beta');
  expect(await source(page)).toContain('Alpha <strong>Beta</strong>');
});

test('Enter, first-paragraph deletion, style shortcut and history keep the Tiptap caret after save',async ({page}) => {
  await start(page,'<p>First</p><p>Second</p>');
  await page.locator('.ProseMirror p').first().click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('Before save');
  await expect(page.locator('.ProseMirror p')).toHaveCount(3);
  await page.locator('.draft-save').click();
  await expect(page.locator('.draft-save')).toBeEnabled();
  await page.locator('.ProseMirror p').first().click();
  await page.evaluate(() => {
    const paragraph=document.querySelector('.ProseMirror p');
    const range=document.createRange(); range.selectNodeContents(paragraph);
    const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await page.keyboard.press('Backspace');
  await expect(page.locator('.ProseMirror p').first()).toBeEmpty();
  await tool(page,'되돌리기 (Ctrl/Cmd+Z)');
  await expect(page.locator('.ProseMirror p').first()).toHaveText('First');
  await tool(page,'다시 실행 (Ctrl/Cmd+Shift+Z)');
  await expect(page.locator('.ProseMirror p').first()).toBeEmpty();
  await page.locator('[data-heading]').selectOption('add-style');
  const dialog=page.getByRole('dialog',{name:'텍스트 스타일 설정'});
  await dialog.locator('[name=style]').selectOption('h1');
  await dialog.locator('[name=shortcut]').focus(); await page.keyboard.press('Control+Alt+7');
  await dialog.getByRole('button',{name:'저장',exact:true}).click();
  await page.locator('.ProseMirror p').nth(1).click();
  await page.keyboard.press('ControlOrMeta+Alt+7');
  await expect(page.locator('.ProseMirror h1')).toContainText('Before save');
  expect(await source(page)).toContain('Second');
});
