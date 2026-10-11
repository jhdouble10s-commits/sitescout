// Lightweight first screen: approved-session project metadata only.
// The editor bundle and project payload are requested after a project choice.
import {client} from './auth-client.js';
import {appAccess, isAccessVerified, verifyAccess} from './app-access.js';
import {fetchProjectIndex} from './cloud-draft-io.js';

const launcher = document.querySelector('#projectLauncher');
const list = launcher.querySelector('.project-launcher-list');
const message = launcher.querySelector('.project-launcher-message');
const newButton = launcher.querySelector('[data-project-new]');
const retryButton = launcher.querySelector('[data-project-retry]');
let invalidated = false;

window.addEventListener('sitescout-identity-invalidated', () => {
  invalidated = true;
  list.replaceChildren();
  launcher.hidden = true;
});

export function hideProjectLauncher() {
  launcher.hidden = true;
}

export async function chooseInitialProject() {
  const access = await appAccess;
  if (!access || invalidated) return null;
  const ownerId = access.user.id;
  return new Promise(resolve => {
    let loadingIndex = false;
    let choosing = false;
    let rowsVisible = false;
    let indexPromise = null;
    const choose = async (action,projectId) => {
      if (choosing || !rowsVisible || !indexPromise || invalidated) return;
      choosing = true;
      message.textContent = action === 'open' ? '선택한 원고를 여는 중입니다.' : '새 작업 공간을 여는 중입니다.';
      launcher.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const index = await indexPromise;
        const verified = isAccessVerified() ? access : await verifyAccess();
        if (!verified || verified.user.id !== ownerId || invalidated) {
          choosing = false;
          if (!invalidated) launcher.querySelectorAll('button').forEach(button => { button.disabled = false; });
          return;
        }
        resolve({action,projectId,index});
      } catch {
        choosing = false;
      }
    };
    newButton.onclick = () => { void choose('new'); };
    const load = async () => {
      if (loadingIndex || choosing || invalidated) return;
      loadingIndex = true;
      rowsVisible = false;
      newButton.disabled = true;
      retryButton.hidden = true;
      message.textContent = '프로젝트 목록을 불러오는 중입니다.';
      try {
        indexPromise = fetchProjectIndex(client,ownerId,async rows => {
          const verified = isAccessVerified() ? access : await verifyAccess();
          if (!verified || verified.user.id !== ownerId || invalidated || !rows.length) return;
          list.replaceChildren();
          rows.forEach(row => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'project-launcher-item';
            button.textContent = row.title;
            button.addEventListener('click',() => { void choose('open',row.project_id); });
            list.append(button);
          });
          rowsVisible = true;
          newButton.disabled = false;
          message.textContent = `${rows.length}개 프로젝트 중 하나를 선택하세요.`;
          launcher.hidden = false;
          document.querySelector('#accessMessage').hidden = true;
        });
        const result = await indexPromise;
        const verified = isAccessVerified() ? access : await verifyAccess();
        if (!verified || verified.user.id !== ownerId || invalidated) return;
        if (!result.rows.length) resolve({action:'new',index:result});
      } catch {
        if (invalidated) return;
        rowsVisible = false;
        list.replaceChildren();
        newButton.disabled = true;
        message.textContent = '프로젝트 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.';
        retryButton.hidden = false;
        retryButton.disabled = false;
        launcher.hidden = false;
        document.querySelector('#accessMessage').hidden = true;
      } finally {
        loadingIndex = false;
      }
    };
    retryButton.onclick = () => { void load(); };
    void load();
  });
}
