import {test,expect} from '@playwright/test';
import JSZip from 'jszip';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {immutableAssetPath} from '../../cloud-asset-path.js';
import {mockApprovedSession,approvedUser} from './approved-session.js';
import {projectCloud} from './project-cloud-fixture.js';

const warning = page => page.evaluate(() => {
  const event=new Event('beforeunload',{cancelable:true});
  window.dispatchEvent(event);
  return event.defaultPrevented;
});
async function start(page,cloud) {
  await mockApprovedSession(page);
  await cloud.attach(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => !document.querySelector('#projectLauncher')?.hidden || window.epubMonacoEditor);
  if (await page.locator('#projectLauncher').isVisible()) await page.locator('[data-project-new]').click();
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
}
async function save(page,cloud) {
  const count=cloud.saveCount;
  await page.locator('.draft-save').click();
  await expect.poll(() => cloud.saveCount).toBeGreaterThan(count);
  await expect(page.locator('.draft-save')).toBeEnabled();
}

test('saved-project list appears before the editor bundle or manuscript is loaded',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;
  let releaseDeletions;
  cloud.deletionGate=new Promise(resolve=>{releaseDeletions=resolve;});
  const projectId='00000000-0000-4000-8000-000000000060';
  const draft={projectId,title:'먼저 보이는 목록',author:'',language:'ko',css:'',
    selectedChapterId:'chapter-list-first',chapters:[{id:'chapter-list-first',title:'본문',xhtml:'<p>선택 후 다운로드</p>',body:'<p>선택 후 다운로드</p>',fileName:'chapter.xhtml'}],
    assets:[],parentToc:[],tocExcluded:[],footnotes:[]};
  cloud.rows.set(projectId,{project_id:projectId,title:draft.title,revision:1,updated_at:new Date().toISOString(),payload:draft});
  await mockApprovedSession(page);
  await cloud.attach(page);
  let releaseEditor;
  let editorRequests=0;
  const editorGate=new Promise(resolve=>{releaseEditor=resolve;});
  await page.route('**/dist/chunks/ui-*.js',async route=>{editorRequests++;await editorGate;await route.continue();});
  try {
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.getByRole('region',{name:'프로젝트 선택'})).toBeVisible();
    await expect(page.locator('.app')).toBeHidden();
    await expect(page.getByRole('button',{name:draft.title,exact:true})).toBeVisible();
    expect(cloud.listCount).toBe(1);
    expect(cloud.readCount).toBe(0);
    expect(editorRequests).toBe(0);
    await page.screenshot({path:test.info().outputPath('project-list-first.png')});
    await page.getByRole('button',{name:draft.title,exact:true}).click();
    expect(cloud.readCount).toBe(0);
    expect(editorRequests).toBe(0);
    releaseDeletions();
    await expect.poll(() => editorRequests).toBe(1);
    releaseEditor();
    await expect(page.locator('#title')).toHaveValue(draft.title);
    await expect(page.locator('#body')).toHaveValue(draft.chapters[0].body);
    await expect(page.getByRole('region',{name:'프로젝트 선택'})).toBeHidden();
    expect(cloud.readCount).toBe(1);
  } finally {releaseDeletions();releaseEditor();}
});

test('list failure offers retry without opening an editor or downloading a manuscript',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;cloud.failList=true;
  const projectId='00000000-0000-4000-8000-000000000061';
  const draft={projectId,title:'재시도할 프로젝트',author:'',language:'ko',css:'',
    selectedChapterId:'chapter-retry',chapters:[{id:'chapter-retry',title:'본문',xhtml:'<p>원고</p>',body:'<p>원고</p>',fileName:'chapter.xhtml'}],
    assets:[],parentToc:[],tocExcluded:[],footnotes:[]};
  cloud.rows.set(projectId,{project_id:projectId,title:draft.title,revision:1,updated_at:new Date().toISOString(),payload:draft});
  await mockApprovedSession(page);await cloud.attach(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const launcher=page.getByRole('region',{name:'프로젝트 선택'});
  await expect(launcher).toBeVisible();
  await expect(launcher).toContainText('목록을 불러오지 못했습니다');
  expect(cloud.readCount).toBe(0);
  expect(await page.evaluate(() => Boolean(window.epubMonacoEditor))).toBe(false);
  cloud.failList=false;
  await launcher.getByRole('button',{name:'목록 다시 불러오기'}).click();
  await expect(launcher.getByRole('button',{name:draft.title})).toBeVisible();
  expect(cloud.readCount).toBe(0);
  await launcher.getByRole('button',{name:'새 EPUB 만들기'}).click();
  await expect(launcher).toBeHidden();
  await expect(page.locator('#title')).toHaveValue('');
  expect(cloud.readCount).toBe(0);
});

test('server-only list and explicit save reopen without local manuscript writes',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await expect.poll(() => cloud.listCount).toBe(1);
  await page.locator('#title').fill('수동 저장 원고');
  await page.locator('#add').click();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p>서버에만 저장</p>'));
  await page.waitForTimeout(1100);
  expect(cloud.saveCount).toBe(0);
  expect(await warning(page)).toBe(true);
  expect(await page.locator('.sync-indicator,.sync-detail,.proofread-state').count()).toBe(0);
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name==='epub-builder-projects'))).toBe(false);
  await save(page,cloud);
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  expect(await warning(page)).toBe(false);
  expect(await page.evaluate(() => [...Object.values(localStorage),...Object.values(sessionStorage)]
    .some(value => value.includes('수동 저장 원고')))).toBe(false);
  const other=await page.context().newPage();
  try {
    await start(other,cloud);
    await other.locator('.sb-projects .tab').click();
    await expect(other.getByRole('button',{name:'수동 저장 원고',exact:true})).toBeVisible();
    await other.getByRole('button',{name:'수동 저장 원고',exact:true}).click();
    await expect(other.locator('#title')).toHaveValue('수동 저장 원고');
    await expect(other.locator('#body')).toHaveValue('<p>서버에만 저장</p>');
  } finally {await other.close();}
});

test('project body appears before four image downloads finish, then restores assets',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;cloud.downloadDelayMs=90;
  let releaseDownloads, downloaded;
  cloud.downloadGate=new Promise(resolve=>{releaseDownloads=resolve;});
  const downloadsStarted=new Promise(resolve=>{downloaded=resolve;});
  cloud.onDownload=()=>downloaded();
  const projectId='00000000-0000-4000-8000-000000000050';
  const assets=Array.from({length:4},(_,index) => {
    const bytes=Buffer.from(`synthetic-image-${index}`);
    const hash=createHash('sha256').update(bytes).digest('hex');
    const storagePath=immutableAssetPath(approvedUser.id,projectId,hash);
    cloud.objects.set(`epub-assets/${storagePath}`,bytes);
    return {name:`image-${index}.png`,type:'image/png',hash,storagePath};
  });
  const draft={projectId,title:'병렬 이미지 원고',author:'',language:'ko',css:'',
    selectedChapterId:'chapter-parallel',chapters:[{id:'chapter-parallel',title:'본문',xhtml:'<p>원문 보존</p>',body:'<p>원문 보존</p>',fileName:'chapter.xhtml'}],
    assets,parentToc:[],tocExcluded:[],footnotes:[]};
  cloud.rows.set(projectId,{project_id:projectId,title:draft.title,revision:1,updated_at:new Date().toISOString(),payload:draft});
  await start(page,cloud);
  await page.locator('.sb-projects .tab').click();
  const started=Date.now();
  await page.getByRole('button',{name:draft.title,exact:true}).click();
  await downloadsStarted;
  await expect(page.locator('#title')).toHaveValue(draft.title);
  await expect(page.locator('#body')).toHaveValue('<p>원문 보존</p>');
  expect(cloud.activeDownloads).toBeGreaterThan(0);
  expect(await page.locator('.draft-save').isDisabled()).toBe(true);
  cloud.downloadGate=null;releaseDownloads();
  await expect(page.locator('.asset-row')).toHaveCount(4);
  await expect(page.locator('.draft-save')).toBeEnabled();
  console.log('SYNTHETIC_PROJECT_OPEN_MS',Date.now()-started,'MAX_DOWNLOADS',cloud.maxActiveDownloads);
  expect(cloud.maxActiveDownloads).toBeGreaterThan(1);
});

test('stale server revision rejects manual save and keeps the current tab manuscript',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('버전 충돌 원고');
  await save(page,cloud);
  const row=[...cloud.rows.values()][0];
  row.revision++;
  row.payload={...row.payload,serverRevision:row.revision,chapters:row.payload.chapters.map(chapter=>({...chapter,xhtml:'<p>다른 탭의 저장본</p>',body:'<p>다른 탭의 저장본</p>'}))};
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p>현재 탭의 미저장 원고</p>'));
  const previousSaves=cloud.saveCount;
  await page.locator('.draft-save').click();
  await expect.poll(()=>cloud.saveCount).toBe(previousSaves+1);
  await expect(page.locator('#status')).toContainText('충돌');
  expect(row.payload.chapters[0].body).toBe('<p>다른 탭의 저장본</p>');
  expect(await page.locator('#body').inputValue()).toBe('<p>현재 탭의 미저장 원고</p>');
  expect(await warning(page)).toBe(true);
});

test('missing image keeps its server manifest while text changes and can be retried by reopening',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;
  const projectId='00000000-0000-4000-8000-000000000053';
  const bytes=Buffer.from('synthetic-recovered-image');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const storagePath=immutableAssetPath(approvedUser.id,projectId,hash);
  const asset={name:'missing.png',type:'image/png',hash,storagePath,originalPath:'OPS/Image/missing.png'};
  const draft={projectId,title:'이미지 복구 원고',author:'',language:'ko',css:'',
    selectedChapterId:'chapter-image',chapters:[{id:'chapter-image',title:'본문',xhtml:'<p>원문 <img src="../Image/missing.png" /></p>',body:'<p>원문 <img src="../Image/missing.png" /></p>',fileName:'chapter.xhtml'}],
    assets:[asset],parentToc:[],tocExcluded:[],footnotes:[]};
  const row={project_id:projectId,title:draft.title,revision:1,updated_at:new Date().toISOString(),payload:draft};
  cloud.rows.set(projectId,row);
  await start(page,cloud);
  await page.locator('.sb-projects .tab').click();
  await page.getByRole('button',{name:draft.title,exact:true}).click();
  await expect(page.locator('#status')).toContainText('불러오지 못했습니다');
  await expect(page.locator('#body')).toHaveValue(draft.chapters[0].body);
  await expect(page.locator('#body')).toBeEnabled();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p>수정 <img src="../Image/missing.png" /></p>'));
  await page.locator('.draft-save').click();
  await expect(page.locator('#status')).toContainText('서버 저장 실패: 이미지 1개');
  expect(cloud.saveCount).toBe(0);
  expect(row.payload.assets).toEqual([asset]);
  expect(await warning(page)).toBe(true);
  cloud.objects.set(`epub-assets/${storagePath}`,bytes);
  await page.getByRole('button',{name:draft.title,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'미저장 변경 이탈 확인'});
  await dialog.getByRole('button',{name:'변경 버리고 이동'}).click();
  await expect(page.locator('.asset-row')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('서버 저장본을 불러왔습니다');
  expect(cloud.rows.get(projectId).payload.assets).toEqual([asset]);
});

test('missing original EPUB resource blocks saving even when no image is missing',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;
  const projectId='00000000-0000-4000-8000-000000000054';
  const bytes=Buffer.from('body { color: #123456; }');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const resource={path:'OPS/Styles/book.css',name:'__epub_resource__:OPS/Styles/book.css',type:'text/css',
    hash,storagePath:immutableAssetPath(approvedUser.id,projectId,hash)};
  const draft={projectId,title:'원본 리소스 복구 원고',author:'',language:'ko',css:'',
    selectedChapterId:'chapter-resource',chapters:[{id:'chapter-resource',title:'본문',xhtml:'<p>원문</p>',body:'<p>원문</p>',fileName:'chapter.xhtml'}],
    assets:[],importedSource:{resources:[resource]},parentToc:[],tocExcluded:[],footnotes:[]};
  cloud.rows.set(projectId,{project_id:projectId,title:draft.title,revision:1,updated_at:new Date().toISOString(),payload:draft});
  await start(page,cloud);
  await page.locator('.sb-projects .tab').click();
  await page.getByRole('button',{name:draft.title,exact:true}).click();
  await expect(page.locator('#status')).toContainText('원본 리소스 1개');
  await expect(page.locator('#body')).toBeEnabled();
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p>수정했지만 저장하지 않음</p>'));
  await page.locator('.draft-save').click();
  await expect(page.locator('#status')).toContainText('서버 저장 실패: 원본 EPUB 리소스 1개');
  expect(cloud.saveCount).toBe(0);
  expect(cloud.rows.get(projectId).payload.importedSource.resources).toEqual([resource]);
  expect(await warning(page)).toBe(true);
});

test('rapid project switch and failed read never mix staged images or replace the open manuscript',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;cloud.downloadDelayMs=180;
  const firstId='00000000-0000-4000-8000-000000000051';
  const secondId='00000000-0000-4000-8000-000000000052';
  const bytes=Buffer.from('synthetic-stale-image');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const storagePath=immutableAssetPath(approvedUser.id,firstId,hash);
  cloud.objects.set(`epub-assets/${storagePath}`,bytes);
  const draft=(projectId,title,body,assets=[]) => ({projectId,title,author:'',language:'ko',css:'',
    selectedChapterId:`chapter-${projectId}`,chapters:[{id:`chapter-${projectId}`,title:'본문',xhtml:body,body,fileName:'chapter.xhtml'}],
    assets,parentToc:[],tocExcluded:[],footnotes:[]});
  for (const item of [draft(firstId,'느린 A','<p>A 원문</p>',[{name:'stale.png',type:'image/png',hash,storagePath}]),draft(secondId,'빠른 B','<p>B 원문</p>')])
    cloud.rows.set(item.projectId,{project_id:item.projectId,title:item.title,revision:1,updated_at:new Date().toISOString(),payload:item});
  await start(page,cloud);
  await page.locator('.sb-projects .tab').click();
  await page.getByRole('button',{name:'느린 A',exact:true}).click();
  await page.getByRole('button',{name:'빠른 B',exact:true}).click();
  await expect(page.locator('#title')).toHaveValue('빠른 B');
  await page.waitForTimeout(400);
  await expect(page.locator('#body')).toHaveValue('<p>B 원문</p>');
  await expect(page.locator('.asset-row')).toHaveCount(0);
  cloud.failReadProjectId=firstId;
  await page.getByRole('button',{name:'느린 A',exact:true}).click();
  await expect(page.locator('#status')).toContainText('프로젝트 열기 실패');
  await expect(page.locator('#title')).toHaveValue('빠른 B');
  await expect(page.locator('#body')).toHaveValue('<p>B 원문</p>');
  await expect(page.locator('.asset-row')).toHaveCount(0);
});

test('legacy IndexedDB manuscripts remain untouched and never enter the server list',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.evaluate(() => new Promise((resolve,reject) => {
    const request=indexedDB.open('epub-builder-projects',4);
    request.onupgradeneeded=() => {
      const db=request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:['ownerId','title']});
    };
    request.onsuccess=() => {
      const db=request.result;
      const transaction=db.transaction('projects','readwrite');
      transaction.objectStore('projects').put({ownerId:'00000000-0000-4000-8000-000000000001',title:'기존 로컬 원고',
        payload:{title:'기존 로컬 원고',chapters:[],projectId:'00000000-0000-4000-8000-000000000099'}});
      transaction.oncomplete=() => {db.close();resolve();};
      transaction.onerror=() => reject(transaction.error);
    };
    request.onerror=() => reject(request.error);
  }));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.epubMonacoEditor && document.querySelector('.ProseMirror'));
  await page.locator('.sb-projects .tab').click();
  await expect(page.getByRole('button',{name:'기존 로컬 원고',exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => new Promise((resolve,reject) => {
    const request=indexedDB.open('epub-builder-projects');
    request.onsuccess=() => {
      const db=request.result,read=db.transaction('projects').objectStore('projects').get(['00000000-0000-4000-8000-000000000001','기존 로컬 원고']);
      read.onsuccess=() => {resolve(read.result?.payload?.title);db.close();};read.onerror=() => reject(read.error);
    };
    request.onerror=() => reject(request.error);
  }))).toBe('기존 로컬 원고');
});

test('failed save keeps memory and extra edit is not automatically saved',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('저장 대기 원고');
  await save(page,cloud);
  cloud.failSave=true;
  await page.evaluate(() => window.epubMonacoEditor.setValue('<p>실패해도 남음</p>'));
  await save(page,cloud);
  await expect(page.locator('#status')).toContainText('서버 저장 실패');
  expect(await page.locator('#body').inputValue()).toBe('<p>실패해도 남음</p>');
  expect(await warning(page)).toBe(true);
  expect([...cloud.rows.values()][0].payload.chapters.some(chapter => chapter.body.includes('실패해도 남음'))).toBe(false);
  cloud.failSave=false;
  cloud.missingMigration=true;
  await save(page,cloud);
  await expect(page.locator('#status')).toContainText('migration');
  expect(await page.locator('#body').inputValue()).toBe('<p>실패해도 남음</p>');
  expect(await warning(page)).toBe(true);
  cloud.missingMigration=false;
  let release,started;
  cloud.saveGate=new Promise(resolve => {release=resolve;});
  const entered=new Promise(resolve => {started=resolve;});cloud.onSave=started;
  await page.locator('.draft-save').click();await entered;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(100);
  await expect(page.locator('.draft-save')).toBeDisabled();
  await page.locator('#author').fill('저장 중 추가 편집');
  release();cloud.saveGate=null;
  await expect(page.locator('.draft-save')).toBeEnabled();
  expect([...cloud.rows.values()][0].payload.author).not.toBe('저장 중 추가 편집');
  expect(await warning(page)).toBe(true);
  const count=cloud.saveCount;
  await page.waitForTimeout(1100);
  expect(cloud.saveCount).toBe(count);
  await page.keyboard.press('Control+s');
  await expect.poll(() => cloud.saveCount).toBe(count+1);
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  expect([...cloud.rows.values()][0].payload.author).toBe('저장 중 추가 편집');
  expect(await warning(page)).toBe(false);
});

test('two explicit saves serialize and the second captures edits made during the first',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('연속 저장 원고');await save(page,cloud);
  let release,started;cloud.saveGate=new Promise(resolve => {release=resolve;});
  const entered=new Promise(resolve => {started=resolve;});cloud.onSave=started;
  await page.locator('#author').fill('첫 저장');
  await page.locator('.draft-save').click();await entered;
  await page.locator('#author').fill('두 번째 저장');
  await page.keyboard.press('Control+s');
  expect(cloud.saveCount).toBe(2);
  cloud.saveGate=null;release();
  await expect.poll(() => cloud.saveCount).toBe(3);
  await expect(page.locator('#status')).toContainText('서버 저장 완료');
  expect([...cloud.rows.values()][0].payload.author).toBe('두 번째 저장');
  expect(await warning(page)).toBe(false);
});

test('discard confirmation appears only when leaving unsaved work',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('이탈 원고');await save(page,cloud);
  await page.locator('.new-book').click();
  await expect(page.getByRole('dialog',{name:'미저장 변경 이탈 확인'})).toHaveCount(0);
  await page.locator('#title').fill('미저장 새 원고');
  await page.locator('.sb-projects .tab').click();
  await page.getByRole('button',{name:'이탈 원고',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'미저장 변경 이탈 확인'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'계속 편집'}).click();
  await expect(page.locator('#title')).toHaveValue('미저장 새 원고');
  await page.getByRole('button',{name:'이탈 원고',exact:true}).click();
  await dialog.getByRole('button',{name:'변경 버리고 이동'}).click();
  await expect(page.locator('#title')).toHaveValue('이탈 원고');
  expect(await warning(page)).toBe(false);
});

test('lease transfer rejects old writer and preserves the in-memory manuscript',async ({browser,page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('권한 원고');await save(page,cloud);
  const projectId=[...cloud.rows.keys()][0],originalLease={...cloud.leases.get(projectId)};
  const context=await browser.newContext({ignoreHTTPSErrors:true,baseURL:'http://127.0.0.1:4173'});
  const other=await context.newPage();
  try {
    await start(other,cloud);
    await other.locator('.sb-projects .tab').click();
    await other.getByRole('button',{name:'권한 원고',exact:true}).click();
    await expect(other.locator('#title')).toHaveValue('권한 원고');
    await expect(other.locator('#title')).toBeDisabled();
    await expect(other.locator('#add')).toBeDisabled();
    await expect(other.locator('#del')).toBeDisabled();
    await expect(other.locator('.ProseMirror')).toHaveAttribute('contenteditable','false');
    await other.getByRole('button',{name:'여기서 편집'}).click();
    await other.getByRole('dialog',{name:'편집 권한 가져오기'}).getByRole('button',{name:'여기서 편집'}).click();
    await expect(other.locator('#title')).toBeEnabled();
    await page.evaluate(() => window.epubMonacoEditor.setValue('<p>이전 탭의 미저장 내용</p>'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#title')).toBeDisabled();
    expect(await page.locator('#body').inputValue()).toBe('<p>이전 탭의 미저장 내용</p>');
    expect(await warning(page)).toBe(true);
    const saved=[...cloud.rows.values()][0].payload;
    expect(saved.chapters.some(chapter => chapter.body.includes('이전 탭의 미저장 내용'))).toBe(false);
    const lateStatus=await page.evaluate(async ({projectId,lease,payload}) => fetch('https://htzojicodwueivybovhy.supabase.co/rest/v1/rpc/overwrite_epub_project',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_project_id:projectId,p_client_id:lease.clientId,p_generation:lease.generation,p_payload:payload}),
    }).then(response => response.status),{projectId,lease:originalLease,payload:{...saved,title:'늦은 저장'}});
    expect(lateStatus).toBe(423);
    const saves=cloud.saveCount;
    await other.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(other.locator('#title')).toBeDisabled();
    await other.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(other.locator('#title')).toBeEnabled();
    expect(cloud.saveCount).toBe(saves);
  } finally {await context.close();}
});

test('image is uploaded only on explicit save and text-only overwrite does not resend it',async ({page}) => {
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('#title').fill('이미지 원고');
  await page.locator('#image').setInputFiles({name:'tiny.png',mimeType:'image/png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=','base64')});
  await expect(page.locator('.asset-row')).toHaveCount(1);
  await page.waitForTimeout(850);
  expect(cloud.uploadCount).toBe(0);
  await save(page,cloud);
  const uploadCount=cloud.uploadCount,uploadBytes=cloud.uploadBytes;
  expect(uploadCount).toBe(1);
  await page.locator('#author').fill('본문만 수정');
  await save(page,cloud);
  expect(cloud.uploadCount).toBe(uploadCount);
  expect(cloud.uploadBytes).toBe(uploadBytes);
});

test('imported EPUB resources survive manual server save, reopen and export',async ({browser,page}) => {
  const zip=new JSZip();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=','base64');
  const font=Buffer.from([0,1,2,3,4,5]);
  zip.file('mimetype','application/epub+zip',{compression:'STORE'});
  zip.file('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">roundtrip</dc:identifier><dc:title>왕복 원고</dc:title><dc:language>ko</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="Text/ch.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="Image/pic.png" media-type="image/png"/><item id="font" href="Fonts/book.otf" media-type="font/otf"/><item id="css" href="Styles/book.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('OPS/Text/ch.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>장</title></head><body><p id="kept">이 장은 표지가 아니라 본문이며 이미지와 글꼴과 목차의 왕복 보존을 확인하기 위해 충분히 긴 문장을 담고 있습니다. 저장한 뒤 다른 브라우저에서 다시 열어도 내용과 원본 리소스가 모두 같아야 합니다. <img src="../Image/pic.png" alt="pic" /></p></body></html>');
  zip.file('OPS/nav.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><ol><li><a href="Text/ch.xhtml#kept">장</a></li></ol></nav></body></html>');
  zip.file('OPS/Image/pic.png',png);zip.file('OPS/Fonts/book.otf',font);
  zip.file('OPS/Styles/book.css','@font-face{font-family:Book;src:url(../Fonts/book.otf)}');
  const cloud=projectCloud();cloud.leaseEnabled=true;await start(page,cloud);
  await page.locator('input[type=file][accept^=".epub"]').setInputFiles({name:'roundtrip.epub',mimeType:'application/epub+zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
  await expect(page.locator('#title')).toHaveValue('왕복 원고');
  await save(page,cloud);
  const context=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true,baseURL:'http://127.0.0.1:4173'});
  const other=await context.newPage();
  try {
    await start(other,cloud);
    await other.locator('.sb-projects .tab').click();
    await other.getByRole('button',{name:'왕복 원고',exact:true}).click();
    await expect(other.locator('#title')).toHaveValue('왕복 원고');
    const pending=other.waitForEvent('download');await other.locator('#export').click();
    const exported=await JSZip.loadAsync(await readFile(await (await pending).path()));
    expect(await exported.file('OPS/Fonts/book.otf').async('nodebuffer')).toEqual(font);
    expect(await exported.file('OPS/Image/pic.png').async('nodebuffer')).toEqual(png);
    expect(await exported.file('OPS/Text/ch.xhtml').async('string')).toContain('id="kept"');
    expect(await exported.file('OPS/nav.xhtml').async('string')).toContain('Text/ch.xhtml#kept');
  } finally {await context.close();}
});
