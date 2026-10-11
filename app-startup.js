import { showStartupPhase } from './startup-screen.js';
import { chooseInitialProject, hideProjectLauncher } from './project-launcher.js';

// Catch both module-loading failures and initialization failures before revealing the app.
try {
  if (document.readyState === 'loading') {
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  const selection = await chooseInitialProject();
  if (selection) {
    const { initializeApp } = await import('./ui.js?v=20261008-startup');
    await initializeApp({initialProjectIndex:selection.index,
      initialProjectId:selection.action === 'open' ? selection.projectId : null});
    hideProjectLauncher();
  }
} catch (error) {
  console.error('편집기 초기화 실패:', error);
  hideProjectLauncher();
  const app = document.querySelector('.app');
  if (app) { app.inert = true; app.style.visibility = 'hidden'; }
  showStartupPhase('error');
}
