import {setFakeGeminiKey} from './ui-helpers.js';
import { test, expect } from '@playwright/test';
import { mockApprovedSession } from './approved-session.js';
async function start(page) {
  page.on('console', message => { if(message.type() === 'error') console.log('CONSOLE ERROR',message.text()); });
  page.on('pageerror', error => console.log('PAGE ERROR',error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED',request.url(),request.failure()?.errorText));
  await mockApprovedSession(page);
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'), null, {timeout:30000});
  await page.locator('#add').click();
}
async function mode(page, visual) {
  if (await page.locator('.rich-editor').evaluate(el => !el.hidden) !== visual) await page.locator('[data-mode-toggle]').click();
}
async function insert(page, text) {
  await page.evaluate(text => {
    const ed=window.epubMonacoEditor, m=ed.getModel();
    ed.pushUndoStop(); ed.executeEdits('test', [{range:m.getFullModelRange(), text}]); ed.pushUndoStop();
  },text);
}
const source = page => page.locator('#body').inputValue();
test('visual edits undo and redo one transaction at a time after save', async ({page}) => {
  await start(page); await mode(page,true);
  await page.locator('#title').fill('단계별 실행 시험');
  await page.locator('.ProseMirror').click();
  await page.keyboard.insertText('Alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Beta');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Gamma');
  await expect(page.locator('#body')).toHaveValue('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
  await page.locator('.draft-save').click();
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  await page.locator('[data-editor-action=undo]').click();
  await expect(page.locator('#body')).toHaveValue('<p>Alpha</p><p>Beta</p><p></p>');
  await page.locator('[data-editor-action=undo]').click();
  await expect(page.locator('#body')).toHaveValue('<p>Alpha</p><p>Beta</p>');
  await page.locator('[data-editor-action=redo]').click();
  await expect(page.locator('#body')).toHaveValue('<p>Alpha</p><p>Beta</p><p></p>');
  await page.locator('[data-editor-action=redo]').click();
  await expect(page.locator('#body')).toHaveValue('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
});
test('chapter history survives modes, navigation, redo branching and save', async ({page}) => {
  await start(page); await mode(page,false);
  const a=await page.locator('#list .chapter.active').getAttribute('data-chapter-id');
  await insert(page,'<p>Alpha</p>');
  await page.locator('#add').click();
  const b=await page.locator('#list .chapter.active').getAttribute('data-chapter-id');
  await insert(page,'<p>Beta</p>');
  await page.locator(`[data-chapter-id="${a}"].chapter`).click();
  await page.locator('[data-editor-action=undo]').click();
  await expect(page.locator('.rich-editor')).toBeHidden();
  expect(await source(page)).not.toContain('Alpha');
  await page.locator(`[data-chapter-id="${b}"].chapter`).click();
  expect(await source(page)).toBe('<p>Beta</p>');
  await page.locator('[data-editor-action=undo]').click();
  expect(await source(page)).not.toContain('Beta');
  await page.locator(`[data-chapter-id="${a}"].chapter`).click();
  await page.locator('[data-editor-action=redo]').click();
  expect(await source(page)).toBe('<p>Alpha</p>');
  await mode(page,true);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' visual');
  await mode(page,false); expect(await source(page)).toContain('visual');
  await page.locator('#title').fill('History test'); await page.locator('.draft-save').click();
  await page.locator('[data-editor-action=undo]').click();
  // keyboard.type emits one visual transaction per character: one undo removes only the last one.
  expect(await source(page)).toBe('<p>Alpha visua</p>');
  await page.locator('[data-editor-action=redo]').click();
  expect(await source(page)).toContain('visual');
  await page.locator('[data-editor-action=undo]').click(); await insert(page,'<p>New branch</p>');
  await expect(page.locator('[data-editor-action=redo]')).toBeDisabled();
});
test('visual undo is isolated, table remains anchored and supports repeated operations', async ({page}) => {
  await start(page); await mode(page,true);
  const a=await page.locator('#list .chapter.active').getAttribute('data-chapter-id');
  await page.locator('.ProseMirror').click(); await page.keyboard.type('One');
  await page.locator('#add').click(); await page.locator('.ProseMirror').click(); await page.keyboard.type('Two');
  await page.locator(`[data-chapter-id="${a}"].chapter`).click();
  await page.locator('[data-editor-action=undo]').click();
  expect(await source(page)).not.toContain('One'); expect(await source(page)).not.toContain('Two');
  await page.locator('[data-editor-action=redo]').click(); expect(await source(page)).toContain('One');
  const table=page.getByRole('button',{name:'표 편집',exact:true}); await table.click();
  await page.getByRole('button',{name:'2×2 표 삽입',exact:true}).click();
  const panel=page.locator('.editor-tools-table'); await expect(panel).toBeVisible();
  await page.getByRole('button',{name:'아래에 행 추가',exact:true}).click();
  await page.getByRole('button',{name:'오른쪽에 열 추가',exact:true}).click();
  await expect(panel).toBeVisible(); await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
  await expect(page.locator('.ProseMirror tr').first().locator('th,td')).toHaveCount(3);
  await expect.poll(async () => { const p=await panel.boundingBox(),t=await table.boundingBox(); return Math.abs(p.y-t.y); }).toBeLessThan(150);
  const p=await panel.boundingBox(),t=await table.boundingBox();
  expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x+p.width).toBeLessThanOrEqual(1600);
  expect(p.x).toBeLessThanOrEqual(t.x+t.width); expect(p.x+p.width).toBeGreaterThan(t.x);
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  const cells=page.locator('.ProseMirror tr').first().locator('th,td');
  await cells.first().click(); await cells.nth(1).click({modifiers:['Shift']});
  await table.click();
  await page.getByRole('button',{name:'셀 병합',exact:true}).click();
  await expect(cells).toHaveCount(2); await expect(panel).toBeVisible();
  await page.getByRole('button',{name:'셀 분할',exact:true}).click();
  await expect(cells).toHaveCount(3); await expect(panel).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  await expect.poll(async()=>{const r=await panel.boundingBox();return r.x+r.width;}).toBeLessThanOrEqual(1280);
  await page.locator('#ctitle').click(); await expect(panel).not.toBeVisible();
});

test('AI and XHTML repairs are undoable; deletion never lends history to a new chapter', async ({page}) => {
  await start(page); await mode(page,false);
  await insert(page,'<table><colgroup><col span="2"></colgroup><tr><td>기도를통해</td></tr></table>');
  const before=await source(page);
  await page.getByRole('button',{name:'XHTML 자동수정',exact:true}).click();
  expect(await source(page)).toContain('<col span="2" />');
  await page.locator('[data-editor-action=undo]').click(); expect(await source(page)).toBe(before);
  await page.locator('[data-editor-action=redo]').click();
  await setFakeGeminiKey(page);
  await page.route('**/v1/interactions',async route => {
    const input=JSON.parse(route.request().postDataJSON().input);
    await route.fulfill({json:{steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({paragraphs:input.paragraphs.map(p=>({id:p.id,correctedText:p.text.replace('기도를통해','기도를 통해')}))})}]}]}});
  });
  await mode(page,true); await page.getByRole('button',{name:'맞춤법 교정',exact:true}).click();
  await expect.poll(()=>source(page)).toContain('기도를 통해');
  await page.locator('[data-editor-action=undo]').click(); expect(await source(page)).toContain('기도를통해');
  await page.locator('[data-editor-action=redo]').click(); expect(await source(page)).toContain('기도를 통해');
  page.on('dialog',d=>d.accept());
  await page.locator('#del').click(); await page.locator('#add').click();
  await expect(page.locator('[data-editor-action=undo]')).toBeDisabled();
  await expect(page.locator('[data-editor-action=redo]')).toBeDisabled();
  expect(await source(page)).not.toContain('기도');
});

test('labels, settings, tooltip alignment and field drag at desktop resolutions', async ({page}) => {
  await start(page);
  for(const width of [1920,2560]) {
    await page.setViewportSize({width,height:1080});
    await expect(page.locator('.app > main')).toHaveCSS('padding-top','30px');
    await expect(page.locator('.app > main')).toHaveCSS('padding-bottom','30px');
    await expect(page.getByRole('button',{name:'맞춤법 교정',exact:true})).toHaveText('맞춤법교정');
    await expect(page.getByRole('button',{name:'XHTML 자동수정',exact:true})).toHaveText('xhtml교정');
    await expect(page.locator('.draft-save')).toHaveText('저장');
    const trigger=page.locator('.draft-save'); await trigger.hover();
    const tip=page.locator('#app-theme-tooltip'); await expect(tip).toBeVisible();
    await expect.poll(async()=> {const a=await tip.boundingBox(),b=await trigger.boundingBox();return Math.abs(a.x+a.width/2-b.x-b.width/2);}).toBeLessThan(2);
    const handle=page.locator('.field-resize-handle');
    const old=await page.locator('#ctitle').boundingBox(),h=await handle.boundingBox();
    await page.mouse.move(h.x+h.width/2,h.y+30); await page.mouse.down(); await page.mouse.move(h.x+h.width/2-40,h.y+30); await page.mouse.up();
    const next=await page.locator('#ctitle').boundingBox(); expect(next.width).toBeLessThan(old.width);
    await page.locator('.settings-button').click();
    await expect(page.getByRole('dialog',{name:'설정',exact:true})).toBeVisible();
    for(const dark of [false,true]) {
      await page.getByRole('switch',{name:'다크 테마'}).setChecked(dark);
      await expect(page.locator('html')).toHaveAttribute('data-theme',dark?'dark':'light');
      await page.screenshot({path:test.info().outputPath(`settings-${width}-${dark}.png`)});
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog',{name:'설정',exact:true})).not.toBeVisible();
  }
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await expect(page.locator('.field-resize-handle')).toBeHidden();
});

test('keyboard history and late AI response never overwrite another chapter', async ({page}) => {
  await start(page); await mode(page,true);
  await page.locator('.ProseMirror').click(); await page.keyboard.type('keyboard');
  await page.keyboard.press('ControlOrMeta+z'); expect(await source(page)).toContain('keyboar</p>');
  await page.keyboard.press('ControlOrMeta+Shift+z'); expect(await source(page)).toContain('keyboard');
  await page.keyboard.press('ControlOrMeta+z'); expect(await source(page)).toContain('keyboar</p>');
  await page.keyboard.press('Control+y');
  expect(await source(page)).toContain('keyboard');
  await mode(page,false); await insert(page,'<p>기도를통해</p>');
  await page.evaluate(() => window.epubMonacoEditor.focus());
  await page.keyboard.press('ControlOrMeta+z'); expect(await source(page)).toContain('keyboard');
  await page.keyboard.press('ControlOrMeta+Shift+z'); expect(await source(page)).toContain('기도를통해');
  const a=await page.locator('#list .chapter.active').getAttribute('data-chapter-id');
  await setFakeGeminiKey(page);
  let release, started;
  const gate=new Promise(resolve=>{release=resolve;});
  const requestStarted=new Promise(resolve=>{started=resolve;});
  await page.route('**/v1/interactions',async route=>{
    const input=JSON.parse(route.request().postDataJSON().input); started(); await gate;
    await route.fulfill({json:{steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({paragraphs:input.paragraphs.map(p=>({id:p.id,correctedText:p.text.replace('기도를통해','기도를 통해')}))})}]}]}});
  });
  try {
    await page.getByRole('button',{name:'맞춤법 교정',exact:true}).click(); await requestStarted;
    await page.locator('#add').click(); await insert(page,'<p>Unrelated chapter</p>');
    release(); await expect(page.locator('#status')).toContainText('교정을 적용했습니다');
    expect(await source(page)).toBe('<p>Unrelated chapter</p>');
    await page.locator(`[data-chapter-id="${a}"].chapter`).click(); expect(await source(page)).toBe('<p>기도를 통해</p>');
  } finally { release(); }
});

test('mobile footer and settings preserve readable labels and theme colors',async ({page})=>{
  await start(page); await page.setViewportSize({width:390,height:844});
  for(const dark of [false,true]) {
    await page.locator('.sb-mobile-trigger').click();
    await page.locator('.settings-button').click();
    await page.getByRole('switch',{name:'다크 테마'}).setChecked(dark);
    const dialog=page.getByRole('dialog',{name:'설정',exact:true});
    const box=await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x+box.width).toBeLessThanOrEqual(390);
    await page.screenshot({path:test.info().outputPath(`settings-mobile-${dark}.png`)});
    await page.keyboard.press('Escape'); await page.mouse.move(0,0);
    const buttons=page.locator('.editor > .toolbar .editor-action-labeled');
    const colors=await buttons.evaluateAll(nodes=>nodes.map(node=>{const s=getComputedStyle(node);return {background:s.backgroundColor,color:s.color,border:s.borderTopColor,height:s.height};}));
    for(const item of colors.slice(0,2)) {expect(item.background).toBe('rgba(0, 0, 0, 0)'); expect(item.border).toBe(item.color); expect(item.height).toBe('36px');}
    expect(colors[2].background).toBe(colors[0].border); expect(colors[2].color).not.toBe(colors[2].background);
    await expect(page.locator('.epub-topbar label').first()).toHaveCSS('font-weight','400');
    await expect(page.locator('.sb-menu-button').first()).toHaveCSS('font-size','14px');
    for(const button of await buttons.all()) {const r=await button.boundingBox();expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(390);}
    await page.screenshot({path:test.info().outputPath(`footer-mobile-${dark}.png`)});
  }
});
