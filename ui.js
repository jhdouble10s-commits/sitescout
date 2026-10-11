// Workspace initialization wires BookProject, Tiptap/Monaco, preview, Supabase, and EPUB modules.
// Check editor selection, chapter history, explicit save/reload, and exported EPUB after wiring changes.
import { client as authClient } from './auth-client.js';
import { appAccess, markAppUiReady, isAccessVerified, verifyAccess } from './app-access.js';
import { signInApproved } from './auth-access.js';
import { diffChars } from 'https://cdn.jsdelivr.net/npm/diff@9.0.0/+esm';
import { requestGeminiCorrections } from './gemini-interactions.js?v=20261007-63';
import { applySourceEdits, chunkProofreadParagraphs, diffPartsToSourceEdits, extractProofreadParagraphs, isSuspiciousCorrection } from './gemini-proofread.js?v=20261007-63';
import { fixXhtmlVoidElements } from './xhtml-tools.js?v=20261007-64';
import { createChapterHistory } from './chapter-history.js';
import { serializeVisualXhtml } from './visual-xhtml.js';
import { DOMParser as ProseMirrorDOMParser, DOMSerializer as ProseMirrorDOMSerializer } from 'prosemirror-model';
import { BookProject } from './book-project.js?v=20261008-styles';
import { stylesFromCss, applyCustomStyle, applyTagStyle } from './text-styles.js';
import { mountTextStyles } from './text-styles-ui.js';
import { styleShortcutBindings } from './style-shortcuts.js';
import { savedAssetPaths } from './cloud-asset-path.js';
import { imageAssetPath, imageReferences, resolveImagePath } from './image-references.js';
import { validateXhtml, equivalentXhtml, xhtmlPreservationIssue, projectXhtmlForVisual } from './xhtml-validation.js?v=20261007-70';
import { formatXhtml, sourceElements, sourceAttribute, elementAtOffset } from './xhtml-source.js?v=20261007-70';
import { xhtmlCompletionContext, monacoAttributeSuggestions, registerXhtmlEmmet } from './xhtml-completion.js';
import { mountEditorTools, editorSearchPlugin, setEditorActionIcon } from './editor-tools.js';
import { createElement as lucideElement, Quote, FilePlus, Upload, Download, ListEnd, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'https://cdn.jsdelivr.net/npm/lucide@1.52.0/+esm';
import { createFocusTrap } from 'https://cdn.jsdelivr.net/npm/focus-trap@8.2.3/+esm';
import { mountAppSidebar } from './sidebar.js?v=20261008-76';
import { installMonacoTheme } from './theme.js?v=20261007-75';
import { mountPreviewDevice, mountPreviewSync } from './preview-ui.js';
import { mountChapterToc } from './chapter-toc-ui.js';
import { createCloudDraftIo } from './cloud-draft-io.js';
import { createEpubFileIo } from './epub-file-io.js';
import { createEpubExporter } from './epub-export.js';
import { parseEpubFile } from './epub-import.js';

export async function initializeApp() {
  const initialAccess = await appAccess;
  if (!initialAccess) return;
  // Existing markup is ID-heavy.  Accept both CSS selectors (`#body`) and
  // bare legacy IDs (`body`) so one selector typo cannot abort UI startup.
  const $ = (selector) => {
    if (typeof selector === 'string' && /^[A-Za-z][\w-]*$/.test(selector)) {
      return document.getElementById(selector) || document.querySelector(selector);
    }
    return document.querySelector(selector);
  };
  const root = document.documentElement;
  const app = $('.app');
  const side = $('.side');
  const top = $('.top');
  const exportButton = $('#export');
  const bookView = $('#bookView');
  const styleView = $('#styleView');
  const chapterList = $('#list');
  const addChapter = $('#add');
  const chapterCard = chapterList.closest('.card');
  const chapterHeader = chapterCard.querySelector('.head');
  let chapterControls = chapterList.parentElement;
  const preview = $('#preview');
  const previewUi = mountPreviewDevice(preview);
  const {previewCard, previewContentRoot} = previewUi;
  const grid = chapterCard.parentElement;
  const editorCard = chapterCard.nextElementSibling;
  const resizeHandles = ['chapters', 'preview'].map((panel) => {
    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle';
    handle.dataset.resizePanel = panel;
    handle.title = panel === 'chapters' ? '책 구성 영역 너비 조절' : '미리보기 영역 너비 조절';
    grid.append(handle);
    return handle;
  });
  const positionResizeHandles = () => {
    resizeHandles[0].style.left = `${chapterCard.offsetLeft + chapterCard.offsetWidth + 8}px`;
    resizeHandles[1].style.left = `${editorCard.offsetLeft + editorCard.offsetWidth + 8}px`;
  };
  const savedWidths = JSON.parse(localStorage.getItem('epub-panel-widths') || '{}');
  if (Number.isFinite(savedWidths.chapters)) grid.style.setProperty('--chapter-width', `${savedWidths.chapters}px`);
  if (Number.isFinite(savedWidths.preview)) grid.style.setProperty('--preview-width', `${savedWidths.preview}px`);
  const savePanelWidths = () => localStorage.setItem('epub-panel-widths', JSON.stringify({
    chapters: Math.round(chapterCard.getBoundingClientRect().width),
    preview: Math.round(previewCard.getBoundingClientRect().width),
  }));
  resizeHandles.forEach((handle) => handle.addEventListener('pointerdown', (event) => {
    if (window.matchMedia('(max-width: 1050px)').matches) return;
    event.preventDefault();
    const panel = handle.dataset.resizePanel;
    const startX = event.clientX;
    const startWidth = panel === 'chapters' ? chapterCard.getBoundingClientRect().width : previewCard.getBoundingClientRect().width;
    const gridWidth = grid.getBoundingClientRect().width;
    const chapterWidth = chapterCard.getBoundingClientRect().width;
    const previewWidth = previewCard.getBoundingClientRect().width;
    const maxWidth = panel === 'chapters'
      ? gridWidth - previewWidth - 420 - 32
      : gridWidth - chapterWidth - 420 - 32;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-resizing');
    const resize = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = panel === 'chapters' ? startWidth + delta : startWidth - delta;
      grid.style.setProperty(panel === 'chapters' ? '--chapter-width' : '--preview-width', `${Math.round(Math.max(panel === 'chapters' ? 210 : 360, Math.min(maxWidth, next)))}px`);
      positionResizeHandles();
    };
    const finish = () => {
      handle.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', resize);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      savePanelWidths();
    };
    handle.addEventListener('pointermove', resize);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }));
  new ResizeObserver(positionResizeHandles).observe(grid);
  root.dataset.theme = localStorage.getItem('epub-theme') || 'dark';

  side.querySelector('.tip').insertAdjacentHTML('beforebegin', `
    <div class="theme-settings">
      <button class="settings-button" type="button" aria-label="설정" title="설정">설정</button>
    </div>
  `);

  top.querySelector('div')?.remove();
  top.classList.add('epub-topbar');
  side.querySelectorAll('[data-view]').forEach((tab) => tab.addEventListener('click', () => {
    // 이후 다른 앱 탭을 추가해도 EPUB 책 정보·내보내기 바는 EPUB 탭에서만 보인다.
    top.hidden = tab.dataset.view !== 'editorView';
  }));
  const accountArea = document.createElement('div');
  accountArea.className = 'account-area';
  accountArea.innerHTML = `<button type="button" class="account-button">로그인</button><div class="account-panel" hidden>
    <h3>Sitescout 로그인</h3>
    <form class="login-form"><label>아이디<input name="username" autocomplete="username" required pattern="[a-z0-9][a-z0-9_.-]{2,31}" /></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" required minlength="6" /></label><div class="account-actions"><button type="submit" class="primary">로그인</button><button type="button" class="secondary account-close">닫기</button></div></form>
    <p class="account-message" aria-live="polite"></p><div class="admin-panel" hidden><h3>사용자 아이디 발급</h3><form class="admin-form"><label>새 아이디<input name="username" required pattern="[a-z0-9][a-z0-9_.-]{2,31}" /></label><label>임시 비밀번호<input name="password" type="password" required minlength="6" /></label><button type="submit" class="secondary">아이디 발급</button></form></div>
  </div>`;
  top.insertBefore(accountArea, exportButton);
  bookView.className = 'book-inline';
  const bookSettings = bookView.querySelector('.settings');
  bookSettings.querySelector('.head')?.remove();
  top.insertBefore(bookView, exportButton);

  const coverInput = $('#coverInput');
  const coverPreview = $('#coverPreview');
  const coverField = coverInput.closest('.field');
  const coverLabel = coverField.querySelector('label');
  const isCoverSelected = () => bookProject.selectedChapter?.type === 'cover';
  // Upload is available inside the selected cover view, not as a book-wide panel.
  coverField.remove();
  coverInput.hidden = true;
  editorCard.append(coverInput);
  const showCoverPreview = () => {
    if (!isCoverSelected()) return;
    const coverSource = coverPreview.getAttribute('src');
    preview.replaceChildren();
    if (!coverSource) return;
    const coverPage = document.createElement('div');
    coverPage.className = 'cover-preview-page';
    const image = document.createElement('img');
    image.src = coverSource;
    image.alt = '표지 이미지';
    coverPage.append(image);
    preview.append(coverPage);
  };
  const renderCoverChapter = () => {
    const cover = bookProject.chapters.find(chapter => chapter.type === 'cover');
    const row = cover && chapterList.querySelector(`[data-chapter-id="${cover.id}"]`);
    if (row) { row.classList.add('cover-chapter'); if (chapterList.firstElementChild !== row) chapterList.prepend(row); }
  };
  new MutationObserver(() => {
    renderCoverChapter();
    if (isCoverSelected()) { renderCoverReadOnly(); showCoverPreview(); }
  }).observe(coverPreview, { attributes:true, attributeFilter:['src'] });
  new MutationObserver(renderCoverChapter).observe(chapterList, { childList:true });

  styleView.remove();
  const cssSettings = styleView.querySelector('.settings');
  cssSettings.id = 'cssPanel';
  cssSettings.className = 'left-panel';
  cssSettings.querySelector('.head')?.remove();
  const cssPresetStoragePrefix = 'epub-builder-css-presets-v2';
  const bookProject = new BookProject();
  let cssPresetOwnerId = null;
  // 프리셋은 사용자가 저장한 항목만 제공한다. 가져온 CSS는 항상 그대로 유지한다.
  const CSS_PRESETS = [];
  const cssEditor = cssSettings.querySelector('#css');
  const cssPresetControl = document.createElement('div');
  cssPresetControl.className = 'css-preset-control';
  cssPresetControl.innerHTML = '<div class="css-preset-row"><label for="cssPreset">프리셋 선택</label><select id="cssPreset" aria-describedby="cssPresetStatus"></select><button type="button" class="css-preset-delete" hidden>삭제</button></div><span id="cssPresetStatus" class="css-preset-status" role="status"></span><div class="css-preset-row"><label for="cssPresetName">CSS 이름</label><input id="cssPresetName" placeholder="프리셋 제목"><button type="button" class="css-preset-save">CSS저장</button></div>';
  const cssPreset = cssPresetControl.querySelector('select');
  const cssPresetStatus = cssPresetControl.querySelector('#cssPresetStatus');
  const cssPresetName = cssPresetControl.querySelector('#cssPresetName');
  const cssPresetSave = cssPresetControl.querySelector('.css-preset-save');
  const cssPresetDelete = cssPresetControl.querySelector('.css-preset-delete');
  const rebuildCssPresetOptions = () => {
    cssPreset.replaceChildren();
    CSS_PRESETS.forEach((preset) => cssPreset.add(new Option(preset.name, preset.id)));
  };
  rebuildCssPresetOptions();
  cssSettings.querySelector('section')?.prepend(cssPresetControl);
  const activeCssPreset = () => CSS_PRESETS.find((preset) => preset.id === bookProject.cssPresetId) || null;
  const updatePresetDeleteButton = () => {
    cssPresetDelete.hidden = !activeCssPreset();
  };
  const updatePresetSaveButton = () => {
    const isUpdating = !cssPresetName.value.trim() && activeCssPreset();
    cssPresetSave.textContent = isUpdating ? '현재 프리셋 저장' : 'CSS저장';
    cssPresetSave.disabled = !cssPresetName.value.trim() && !activeCssPreset();
  };
  const renderCssPresetSelection = () => {
    const preset = activeCssPreset();
    cssPreset.value = preset?.id || '';
    if (!preset) cssPreset.selectedIndex = -1;
    cssPreset.disabled = CSS_PRESETS.length === 0;
    cssPresetStatus.textContent = preset
      ? (cssEditor.value === preset.css ? `${preset.name} 적용 중` : `${preset.name} · 수정됨`)
      : (cssEditor.value ? '직접 편집한 CSS' : '프리셋 미선택');
    updatePresetDeleteButton();
    updatePresetSaveButton();
  };
  const cssPresetStorageKey = () => cssPresetOwnerId ? `${cssPresetStoragePrefix}:${cssPresetOwnerId}` : null;
  const saveAccountCssPresets = () => {
    const key = cssPresetStorageKey();
    if (!key) return false;
    localStorage.setItem(key, JSON.stringify(CSS_PRESETS.filter((item) => item.custom)));
    return true;
  };
  const loadAccountCssPresets = (ownerId) => {
    cssPresetOwnerId = ownerId || null;
    let saved = [];
    if (cssPresetOwnerId) {
      try { saved = JSON.parse(localStorage.getItem(cssPresetStorageKey()) || '[]'); } catch { saved = []; }
    }
    CSS_PRESETS.splice(0, CSS_PRESETS.length, ...saved.filter((preset) => preset?.id && preset?.name && typeof preset.css === 'string'));
    rebuildCssPresetOptions();
    if (!CSS_PRESETS.some(preset => preset.id === bookProject.cssPresetId)) bookProject.cssPresetId = null;
    renderCssPresetSelection();
  };
  renderCssPresetSelection();
  cssPreset.addEventListener('change', () => {
    const preset = CSS_PRESETS.find((item) => item.id === cssPreset.value);
    if (!preset) { renderCssPresetSelection(); return; }
    bookProject.cssPresetId = preset.id;
    cssEditor.value = preset.css;
    cssEditor.dispatchEvent(new Event('input', { bubbles:true }));
    // 프리셋 선택은 곧 현재 책의 공통 CSS 변경이다. 별도 적용 단계 없이
    // 편집기·미리보기·내보내기가 같은 값을 사용하도록 즉시 다시 렌더링한다.
    refreshPreview();
    renderCssPresetSelection();
  });
  cssPresetName.addEventListener('input', updatePresetSaveButton);
  let hydratingCss = false;
  cssEditor.addEventListener('input', () => {
    if (!hydratingCss) { bookProject.dirty = true; bookProject.revision++; }
    renderCssPresetSelection();
  });
  const hydrateCssValue = (value) => {
    hydratingCss = true;
    try {
      cssEditor.value = value;
      window.epubCssMonacoEditor?.setValue(value);
      renderCssPresetSelection();
    } finally { hydratingCss = false; }
  };
  cssPresetSave.addEventListener('click', () => {
    if (!cssPresetOwnerId) { setStatus('CSS 프리셋은 로그인한 계정에서만 저장할 수 있습니다.', 'error'); return; }
    const name = cssPresetName.value.trim();
    const currentPreset = activeCssPreset();
    if (!name && !currentPreset) {
      cssPresetName.focus();
      setStatus('저장할 프리셋을 선택하거나 CSS 이름을 입력하세요.', 'error');
      return;
    }
    const existing = name ? CSS_PRESETS.find((preset) => preset.custom && preset.name === name) : currentPreset;
    if (existing && !window.confirm(`“${existing.name}” 프리셋을 현재 CSS로 덮어쓸까요?`)) return;
    const preset = existing || { id:`user-${Date.now()}`, name, css:'', custom:true };
    preset.css = cssEditor.value;
    if (!existing) {
      CSS_PRESETS.push(preset);
      cssPreset.add(new Option(preset.name, preset.id));
    }
    saveAccountCssPresets();
    bookProject.cssPresetId = preset.id;
    cssPresetName.value = '';
    renderCssPresetSelection();
    setStatus(`“${preset.name}” 프리셋을 저장했습니다.`);
  });
  cssPresetDelete.addEventListener('click', () => {
    if (!cssPresetOwnerId) { setStatus('CSS 프리셋은 로그인한 계정에서만 관리할 수 있습니다.', 'error'); return; }
    const presetIndex = CSS_PRESETS.findIndex((preset) => preset.id === bookProject.cssPresetId);
    if (presetIndex < 0) return;
    const preset = CSS_PRESETS[presetIndex];
    if (!window.confirm(`“${preset.name}” 프리셋을 삭제할까요?`)) return;
    CSS_PRESETS.splice(presetIndex, 1);
    Array.from(cssPreset.options).find((option) => option.value === preset.id)?.remove();
    saveAccountCssPresets();
    bookProject.cssPresetId = null;
    renderCssPresetSelection();
    setStatus(`“${preset.name}” 프리셋을 삭제했습니다.`);
  });
  chapterHeader.textContent = '';
  chapterHeader.insertAdjacentHTML('afterbegin', `
    <div class="left-tabs">
      <button class="left-tab active" type="button" data-panel="chaptersPanel">책의 구성</button>
      <button class="left-tab" type="button" data-panel="cssPanel">공통 CSS</button>
      <button class="left-tab" type="button" data-panel="assetsPanel">이미지</button>
    </div>
  `);
  chapterCard.classList.add('chapter-card');
  const panelHost = document.createElement('div');
  panelHost.className = 'left-panel-host';
  chapterControls = document.createElement('div');
  chapterControls.id = 'chaptersPanel';
  chapterControls.className = 'left-panel active';
  const chapterFooter = document.createElement('footer');
  chapterFooter.className = 'chapter-footer';
  const deleteChapter = $('#del');
  deleteChapter.textContent = '삭제';
  deleteChapter.setAttribute('aria-label', '선택한 장 삭제');
  chapterFooter.append(addChapter, deleteChapter);
  chapterControls.append(chapterList, chapterFooter);
  const assetsPanel = document.createElement('div');
  assetsPanel.id = 'assetsPanel';
  assetsPanel.className = 'left-panel';
  assetsPanel.innerHTML = '<label class="asset-upload" for="image">이미지·아이콘 업로드</label><p class="asset-hint">PNG, JPG, GIF, SVG 파일을 업로드해 본문 또는 아이콘으로 사용하세요.</p><p class="asset-hint">본문 삽입 예시: <code>&lt;img src="../Image/파일명.png" alt="이미지 설명"&gt;</code></p><ul id="assetList" class="images"></ul>';
  panelHost.append(chapterControls, cssSettings, assetsPanel);
  chapterCard.append(panelHost);

  $('.left-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('.left-tab');
    if (!button) return;
    $('.left-tabs').querySelectorAll('button').forEach((tab) => tab.classList.toggle('active', tab === button));
    chapterCard.querySelectorAll('.left-panel').forEach((panel) => panel.classList.toggle('active', panel.id === button.dataset.panel));
  });

  const htmlEditor = $('#body');
  htmlEditor.wrap = 'soft';
  const htmlField = htmlEditor.closest('.full');
  const editorFields = htmlEditor.closest('.fields');
  const editor = htmlEditor.closest('.editor');
  const editorActions = editor.querySelector('.toolbar');
  // 제목·목차 필드와 실제 편집 영역을 분리해, 본문만 남은 높이를 사용하게 한다.
  editorActions.before(htmlField);
  const xhtmlDiagnostics = document.createElement('div');
  xhtmlDiagnostics.className = 'xhtml-diagnostics';
  xhtmlDiagnostics.hidden = true;
  xhtmlDiagnostics.setAttribute('role', 'status');
  htmlField.append(xhtmlDiagnostics);
  const tocLevel = $('#clevel');
  const tocField = tocLevel.parentElement;
  const titleField = $('#ctitle').parentElement;
  const sigilFileField = document.createElement('div');
  const sigilFileName = document.createElement('input');
  sigilFileName.id = 'sigilFileName';
  sigilFileName.spellcheck = false;
  sigilFileName.placeholder = 'chapter-001.xhtml';
  sigilFileField.innerHTML = '<label for="sigilFileName">Sigil 파일명</label>';
  sigilFileField.append(sigilFileName);
  titleField.after(sigilFileField);
  tocField.querySelector('label').textContent = '상위 목차';
  tocLevel.hidden = true;
  tocLevel.value = 1;
  const parentToc = document.createElement('select');
  parentToc.setAttribute('aria-label', '상위 목차 선택');
  parentToc.hidden = true;
  const parentTocPicker = document.createElement('div');
  parentTocPicker.className = 'parent-toc-picker';
  const parentTocButton = document.createElement('button');
  parentTocButton.type = 'button';
  parentTocButton.className = 'parent-toc-button';
  parentTocButton.setAttribute('aria-haspopup', 'listbox');
  parentTocButton.setAttribute('aria-expanded', 'false');
  const parentTocMenu = document.createElement('div');
  parentTocMenu.className = 'parent-toc-menu editor-popover-motion';
  parentTocMenu.setAttribute('role', 'listbox');
  parentTocMenu.hidden = true;
  parentTocPicker.append(parentTocButton);
  document.body.append(parentTocMenu);
  tocField.append(parentToc, parentTocPicker);
  const fieldResizeHandle = document.createElement('div');
  fieldResizeHandle.className = 'field-resize-handle';
  fieldResizeHandle.tabIndex = 0;
  fieldResizeHandle.setAttribute('role', 'separator');
  fieldResizeHandle.setAttribute('aria-orientation', 'vertical');
  fieldResizeHandle.setAttribute('aria-label', '장 제목 영역 너비 조절');
  fieldResizeHandle.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const width = Math.max(120, Math.min(editorFields.clientWidth - 260, titleField.clientWidth + (event.key === 'ArrowRight' ? 16 : -16)));
    editorFields.classList.add('is-custom-width');
    editorFields.style.setProperty('--chapter-title-width', `${width}px`);
    localStorage.setItem('epub-chapter-title-width', String(width));
    positionFieldResizeHandle();
  });
  fieldResizeHandle.title = '장 제목과 Sigil 파일명 영역 너비 조절';
  editorFields.append(fieldResizeHandle);
  const savedFieldWidth = Number(localStorage.getItem('epub-chapter-title-width'));
  if (Number.isFinite(savedFieldWidth) && savedFieldWidth >= 120) {
    editorFields.classList.add('is-custom-width');
    editorFields.style.setProperty('--chapter-title-width', `${savedFieldWidth}px`);
  }
  const positionFieldResizeHandle = () => {
    if (!titleField) return;
    const titleBounds = titleField.getBoundingClientRect();
    const sigilBounds = sigilFileField.getBoundingClientRect();
    const fieldsBounds = editorFields.getBoundingClientRect();
    fieldResizeHandle.hidden = Math.abs(titleBounds.top - sigilBounds.top) > 1;
    fieldResizeHandle.style.left = `${Math.round((titleBounds.right + sigilBounds.left) / 2 - fieldsBounds.left)}px`;
  };
  new ResizeObserver(positionFieldResizeHandle).observe(editorFields);
  requestAnimationFrame(positionFieldResizeHandle);
  fieldResizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    fieldResizeHandle.setPointerCapture(event.pointerId);
    fieldResizeHandle.classList.add('is-resizing');
  });
  fieldResizeHandle.addEventListener('pointermove', (event) => {
    if (!fieldResizeHandle.hasPointerCapture(event.pointerId)) return;
    const bounds = editorFields.getBoundingClientRect();
    const width = Math.max(120, Math.min(bounds.width - 260, event.clientX - bounds.left));
    editorFields.classList.add('is-custom-width');
    editorFields.style.setProperty('--chapter-title-width', `${Math.round(width)}px`);
    requestAnimationFrame(positionFieldResizeHandle);
  });
  const stopFieldResize = (event) => {
    if (!fieldResizeHandle.hasPointerCapture(event.pointerId)) return;
    fieldResizeHandle.releasePointerCapture(event.pointerId);
    fieldResizeHandle.classList.remove('is-resizing');
    const width = Math.round(editorFields.querySelector(':scope > div')?.getBoundingClientRect().width || 0);
    if (width) localStorage.setItem('epub-chapter-title-width', String(width));
    positionFieldResizeHandle();
  };
  fieldResizeHandle.addEventListener('pointerup', stopFieldResize);
  fieldResizeHandle.addEventListener('pointercancel', stopFieldResize);
  const tocExcluded = new Set();
  const parentTocMap = new Map();
  const chapterFileNames = new Map();
  const defaultChapterFileName = (index) => `DOC-${String(index + 1).padStart(3, '0')}.xhtml`;
  const currentChapterFileName = (index) => chapterFileNames.get(index) || defaultChapterFileName(index);
  const syncSigilFileNameField = () => { sigilFileName.value = currentChapterFileName(activeChapterIndex()); };
  sigilFileName.addEventListener('input', () => { chapterFileNames.set(activeChapterIndex(), sigilFileName.value.trim()); bookProject.dirty = true; bookProject.revision++; });
  chapterList.addEventListener('click', () => {
    if (!collectingDraft) syncSigilFileNameField();
  });
  addChapter.addEventListener('click', () => requestAnimationFrame(syncSigilFileNameField));
  // Only root entries which actually own descendants can be collapsed.
  // This state is deliberately independent from the selected chapter state.
  const collapsedTocRoots = new Set();
  // 선택은 화면 행 순서나 spine index가 아니라 안정적인 chapter.id만 기준으로 한다.
  // index는 TOC/spine의 순서를 표현할 때에만 파생값으로 사용한다.
  const createChapterId = () => `chapter-${crypto.randomUUID()}`;
  const ensureChapterId = (chapter) => {
    if (!chapter.dataset.chapterId) chapter.dataset.chapterId = createChapterId();
    return chapter.dataset.chapterId;
  };
  Array.from(chapterList.querySelectorAll('.chapter[data-i]')).forEach(ensureChapterId);
  const selectedChapterElement = () => Array.from(chapterList.querySelectorAll('.chapter[data-i]'))
    .find((chapter) => chapter.dataset.chapterId === bookProject.selectedChapterId) || null;
  const activeChapterIndex = () => {
    return Number(selectedChapterElement()?.dataset.i || 0);
  };
  // Keep an independent snapshot for every legacy chapter.  Saving a draft
  // must never need to click through the chapter list and reuse one editor.
  const chapterAt = (slot) => {
    const id = chapterList.querySelector(`.chapter[data-i="${slot}"]`)?.dataset.chapterId;
    return bookProject.chapters.find(chapter => chapter.id === id);
  };
  const upsertChapterAt = (slot, source) => {
    const row = chapterList.querySelector(`.chapter[data-i="${slot}"]`);
    if (!row) return;
    const id = ensureChapterId(row);
    if (!bookProject.update(id, source)) bookProject.add({ ...source, id });
  };
  // EPUB import/load hydrates several chapters in a row.  Those writes are
  // state restoration, not user edits; firing the editor input pipeline here
  // can make Monaco's previous model overwrite the incoming XHTML.
  let hydratingChapter = false;
  const snapshotCurrentChapter = () => {
    if (hydratingChapter || !bookProject.selectedChapter) return;
    const index = activeChapterIndex();
    if (!Number.isInteger(index)) return;
    const snapshot = {
      id:bookProject.selectedChapterId,
      title: $('#ctitle').value,
      level: Math.max(1, Math.min(3, Number($('#clevel').value) || 1)),
      body: htmlEditor.value,
      fileName: currentChapterFileName(index),
    };
    const currentChapter = bookProject.selectedChapter;
    if (currentChapter.title === snapshot.title && currentChapter.level === snapshot.level
      && currentChapter.xhtml === snapshot.body && currentChapter.fileName === snapshot.fileName) return;
    window.recordChapterEdit?.(bookProject.selectedChapter, snapshot.body);
    bookProject.update(bookProject.selectedChapterId, snapshot);
    const chapterButton = chapterList.querySelector(`.chapter[data-i="${index}"]`);
    if (chapterButton) setChapterButtonLabel(chapterButton, snapshot.title, index);
  };
  const setChapterButtonLabel = (chapter, title, index) => {
    const number = chapter.querySelector('.num') || document.createElement('span');
    number.className = 'num';
    number.textContent = String(index + 1);
    chapter.replaceChildren(number, document.createTextNode(title || '제목 없는 장'));
  };
  const selectManagedChapter = (index) => {
    const target = chapterList.querySelector(`.chapter[data-i="${index}"]`);
    const snapshot = chapterAt(index);
    if (!target || !snapshot) return;
    const current = activeChapterIndex();
    if (bookProject.selectedChapterId && current !== index) {
      saveCurrentChapter();
      synchronizeFootnotes();
    }
    closeCoverReadOnly();
    chapterList.querySelector('.cover-chapter')?.classList.remove('active');
    bookProject.selectedChapterId = ensureChapterId(target);
    chapterList.querySelectorAll('.chapter[data-i]').forEach((chapter) => chapter.classList.toggle('active', chapter.dataset.chapterId === bookProject.selectedChapterId));
    setCurrentChapter({ ...snapshot, fileName:currentChapterFileName(index) });
    syncOpenChapterEditor();
    if (isCoverSelected()) openCoverReadOnly();
    refreshPreview();
    validateHtml();
    scheduleChapterControlsRefresh();
  };
  const bindManagedChapter = (chapter) => {
    chapter.onclick = (event) => {
      if (event.target.closest('.toc-toggle,.drag-handle')) return;
      const bounds = chapter.getBoundingClientRect();
      if (bounds.right - event.clientX <= 38) return;
      event.preventDefault();
      event.stopPropagation();
      selectManagedChapter(Number(chapter.dataset.i));
    };
  };
  Array.from(chapterList.querySelectorAll('.chapter[data-i]')).forEach(bindManagedChapter);
  addChapter.addEventListener('click', () => {
    if (!bookProject.chapters.some(chapter => chapter.type === 'cover')) {
      saveCurrentChapter();
      // Reuse the special-page factory; an image resource alone is not a cover page.
      const meta = importedEpub?.chapterMeta.find(item => importedEpub.coverPagePaths.includes(item.path));
      const cover = addSpecialChapter('cover', meta ? {
        originalPath:meta.path, fileName:meta.path.split('/').pop(), xhtml:meta.body,
        title:meta.tocTitle || '표지', includeInToc:meta.includeInToc, generated:false,
      } : importedEpub ? { generated:false } : {});
      if (importedEpub) {
        importedEpub.coverDeleted = false;
        const asset = previewAssetForPath(importedEpub.coverImagePath);
        if (asset) {
          asset.isCover = true;
          coverPreview.src = asset.url;
          coverPreview.hidden = false;
          if (!meta) bookProject.update(cover.id, {
            xhtml:`<p><img src="${epubEscape(relativeEpubPath(`${importedEpub.packageBase}text/${cover.fileName}`, importedEpub.coverImagePath))}" alt="표지" /></p>`,
          });
        }
      }
      // Keep a selected body chapter in place so the next click uses the
      // existing sibling insertion rule. An empty project selects its cover.
      if (!bookProject.selectedChapter) {
        const row = chapterList.querySelector(`[data-chapter-id="${cover.id}"]`);
        selectManagedChapter(Number(row.dataset.i));
      }
      refreshChapterControls();
      setStatus('표지를 추가했습니다. 다시 장 추가를 누르면 일반 장을 추가합니다.');
      return;
    }
    snapshotCurrentChapter();
    const indexes = Array.from(chapterList.querySelectorAll('.chapter[data-i]')).map((chapter) => Number(chapter.dataset.i));
    const index = indexes.length ? Math.max(...indexes) + 1 : 0;
    const chapter = document.createElement('button');
    chapter.type = 'button';
    chapter.className = 'chapter';
    chapter.dataset.i = String(index);
    ensureChapterId(chapter);
    setChapterButtonLabel(chapter, '새 장', index);
    const currentIndex = activeChapterIndex();
    const current = chapterList.querySelector(`.chapter[data-i="${currentIndex}"]`);
    const parent = parentTocMap.get(currentIndex);
    bookProject.add({ id:chapter.dataset.chapterId, title:'새 장', level:Math.max(1, Number($('#clevel').value) || 1), body:'<p></p>', fileName:defaultChapterFileName(index) });
    if (parent !== undefined) parentTocMap.set(index, parent);
    chapterList.insertBefore(chapter, current?.nextSibling || null);
    bindManagedChapter(chapter);
    selectManagedChapter(index);
  });
  $('#del').addEventListener('click', (event) => {
    // 이전 삭제 핸들러가 먼저 실행해 snapshot을 섞지 못하게 한다.
    event.stopImmediatePropagation();
    const chapters = Array.from(chapterList.querySelectorAll('.chapter[data-i]'));
    if (!bookProject.selectedChapter) return;
    const removedChapter = bookProject.selectedChapter;
    const deleted = activeChapterIndex();
    saveCurrentChapter();
    const target = chapterList.querySelector(`.chapter[data-i="${deleted}"]`);
    target?.remove();
    const remaining = Array.from(chapterList.querySelectorAll('.chapter[data-i]'));
    const remap = new Map(remaining.map((chapter, next) => [Number(chapter.dataset.i), next]));
    const remapMap = (source) => {
      const next = new Map();
      source.forEach((value, key) => { if (remap.has(key)) next.set(remap.get(key), value); });
      return next;
    };
    bookProject.remove(target.dataset.chapterId);
    if (removedChapter.type === 'cover') {
      coverPreview.removeAttribute('src');
      previewAssets.forEach(asset => { asset.isCover = false; });
      if (importedEpub) importedEpub.coverDeleted = true;
    }
    if (removedChapter.type === 'footnotes') footnotes.clear();
    else footnotes.forEach((note, id) => { if (note.sourceChapterId === removedChapter.id) footnotes.delete(id); });
    synchronizeFootnotes();
    const nextFiles = remapMap(chapterFileNames); chapterFileNames.clear(); nextFiles.forEach((value, key) => chapterFileNames.set(key, value));
    const nextExcluded = new Set(Array.from(tocExcluded).filter((index) => remap.has(index)).map((index) => remap.get(index)));
    tocExcluded.clear(); nextExcluded.forEach((index) => tocExcluded.add(index));
    const nextParents = new Map();
    parentTocMap.forEach((parent, child) => { if (remap.has(child) && remap.has(parent)) nextParents.set(remap.get(child), remap.get(parent)); });
    parentTocMap.clear(); nextParents.forEach((parent, child) => parentTocMap.set(child, parent));
    remaining.forEach((chapter) => {
      const next = remap.get(Number(chapter.dataset.i));
      chapter.dataset.i = String(next);
      setChapterButtonLabel(chapter, chapterLabel(chapter), next);
      bindManagedChapter(chapter);
    });
    // The deleted editor buffer must never be committed into the next ID.
    if (remaining.length) {
      const next = selectedChapterElement() || remaining[0];
      setCurrentChapter(chapterAt(Number(next.dataset.i)));
      selectManagedChapter(Number(next.dataset.i));
    } else { closeCoverReadOnly(); htmlEditor.value = ''; window.loadXhtmlMonaco?.(''); setVisualHtml(''); refreshPreview(); }
    refreshChapterControls();
  }, true);
  snapshotCurrentChapter();
  ['#ctitle', '#clevel', '#body'].forEach((selector) => $(selector).addEventListener('input', snapshotCurrentChapter));
  sigilFileName.addEventListener('input', snapshotCurrentChapter);
  addChapter.addEventListener('click', snapshotCurrentChapter);
  const {chapterLabel, refreshChapterControls, scheduleChapterControlsRefresh} = mountChapterToc({
    chapterList, parentToc, parentTocMap, collapsedTocRoots, tocExcluded,
    parentTocButton, parentTocMenu, parentTocPicker, bookProject, activeChapterIndex,
    selectedChapterElement, saveCurrentChapter, isCoverSelected,
  });
  const useAssetAwareExporter = true;
  exportButton.addEventListener('click', () => {
    if (useAssetAwareExporter) return;
    if (!tocExcluded.size && !parentTocMap.size) return;
    const originalMap = Array.prototype.map;
    Array.prototype.map = function patchedMap(callback, thisArg) {
      const looksLikeChapters = this.length && this.every((item) => item && typeof item.title === 'string' && typeof item.body === 'string');
      if (!looksLikeChapters) return originalMap.call(this, callback, thisArg);
      const items = originalMap.call(this, (chapter, index) => ({
        index,
        markup: callback.call(thisArg, chapter, index),
      })).filter((item) => !tocExcluded.has(item.index));
      const included = new Set(items.map((item) => item.index));
      const exportParent = (index) => {
        const seen = new Set([index]);
        let parent = parentTocMap.get(index);
        while (parent !== undefined && !seen.has(parent)) {
          if (included.has(parent)) return parent;
          seen.add(parent);
          parent = parentTocMap.get(parent);
        }
        return null;
      };
      const renderChildren = (parent) => items
        .filter((item) => exportParent(item.index) === parent)
        .map((item) => {
          const children = renderChildren(item.index);
          return children ? item.markup.replace(/<\/li>$/, `<ol>${children}</ol></li>`) : item.markup;
        }).join('');
      return [renderChildren(null)];
    };
    setTimeout(() => { Array.prototype.map = originalMap; }, 0);
  }, true);
  const codeEditor = document.createElement('div');
  codeEditor.className = 'code-editor';
  const lineNumbers = document.createElement('pre');
  lineNumbers.className = 'line-numbers';
  htmlEditor.before(codeEditor);
  codeEditor.append(lineNumbers, htmlEditor);
  const previewAssets = new Map();
  const unresolvedAssets = new Map();
  const assetHash = async (blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const revokePreviewAssetUrl = (asset) => {
    if (asset?.url?.startsWith('blob:')) URL.revokeObjectURL(asset.url);
  };
  const clearPreviewAssets = () => {
    previewAssets.forEach(revokePreviewAssetUrl);
    previewAssets.clear();
    unresolvedAssets.clear();
  };
  window.addEventListener('pagehide', clearPreviewAssets, { once:true });
  // 본문 XHTML에는 noteref 링크만 두고, 각주 본문은 이 저장 가능한 목록으로
  // 관리한다. id는 표시 번호와 분리되어 삭제·재정렬 후에도 링크가 유지된다.
  const footnotes = new Map();
  // 가져온 EPUB은 원본 경로·spine·TOC 정보를 유지해 재내보낼 때 사용한다.
  let importedEpub = null;
  // Imported EPUB resources are blobs in IndexedDB/Storage, never numeric
  // arrays in a draft JSON payload.  Image manifest entries continue to use
  // the normal preview asset store so existing drafts remain compatible.
  const sourceAssetName = (path) => `__epub_resource__:${path}`;
  const sourceMediaType = (path) => {
    const extension = path.split('.').pop()?.toLowerCase();
    return ({ css:'text/css', xhtml:'application/xhtml+xml', html:'application/xhtml+xml', htm:'application/xhtml+xml',
      opf:'application/oebps-package+xml', ncx:'application/x-dtbncx+xml', xml:'application/xml',
      ttf:'font/ttf', otf:'font/otf', woff:'font/woff', woff2:'font/woff2', js:'application/javascript' })[extension] || 'application/octet-stream';
  };
  const importedSourcePayload = () => {
    if (!importedEpub) return null;
    const { files, resourceManifest = [], resourceHashes, ...meta } = importedEpub;
    const imagePaths = new Set(Array.from(previewAssets.values(), asset => asset.originalPath).filter(Boolean));
    const previous = new Map(resourceManifest.map(item => [item.path, item]));
    const resources = Array.from(files || [], ([path]) => path)
      .filter(path => !imagePaths.has(path))
      .map(path => ({ path, name:sourceAssetName(path), type:sourceMediaType(path), ...(previous.get(path) || {}) }));
    return { ...meta, resources };
  };
  const sourceAssetEntries = (draft) => {
    if (!importedEpub || !draft.importedSource?.resources) return [];
    return draft.importedSource.resources.map(resource => {
      const bytes = importedEpub.files.get(resource.path);
      return [resource.name || sourceAssetName(resource.path), {
        blob:bytes ? new Blob([bytes], {type:resource.type || sourceMediaType(resource.path)}) : null,
        type:resource.type || sourceMediaType(resource.path), originalPath:resource.path, hash:resource.hash,
        storagePath:resource.storagePath, sourceResource:true,
      }];
    });
  };
  const cleanAssetName = (value) => value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  const uniqueAssetName = (value, exclude = '') => {
    const cleaned = cleanAssetName(value) || 'image.png';
    const dot = cleaned.lastIndexOf('.');
    const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const extension = dot > 0 ? cleaned.slice(dot) : '';
    let candidate = `${base}${extension}`;
    let number = 2;
    while ((previewAssets.has(candidate) || unresolvedAssets.has(candidate)) && candidate !== exclude) {
      candidate = `${base}-${number}${extension}`;
      number += 1;
    }
    return candidate;
  };
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sanitiseSvg = (source) => source
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
  const toPreviewAsset = async (file) => {
    if (file.type === 'image/svg+xml') {
      const safeSvg = sanitiseSvg(await file.text());
      const blob = new Blob([safeSvg], { type:'image/svg+xml' });
      return { type:file.type, url:URL.createObjectURL(blob), blob };
    }
    return { type:file.type || 'image/png', url:URL.createObjectURL(file), blob:file };
  };
  const previewAssetForPath = (path) => previewAssets.get(path)
    || Array.from(previewAssets.values()).find((asset) => asset.originalPath === path);
  const savedCoverAsset = () => Array.from(previewAssets.values()).find(asset => asset.isCover)
    || Array.from(previewAssets.values()).find(asset => /(?:^|[\\/_-])cover(?:[._-]|$)/i.test(asset.originalPath || ''));
  const hydratePreviewAssets = () => {
    hydrateResourceImages(previewContentRoot(), activeChapterIndex());
  };
  const resolveResourceUrl = (source, chapterIndex = activeChapterIndex()) => {
      if (!source || /^(?:data:|blob:|https?:|#)/i.test(source)) return source;
      const chapter = chapterAt(chapterIndex);
      const activePath = chapter?.originalPath;
      const resolvedPath = resolveImagePath(source,activePath || `EPUB/text/${chapter?.fileName || 'chapter.xhtml'}`);
      const exact = Array.from(previewAssets).find(([name,asset]) => imageAssetPath(name,asset) === resolvedPath);
      if (exact) return exact[1].url;
      let path = source;
      if (source.startsWith('images/')) path = source.slice(7);
      else if (source.startsWith('../Image/')) path = source.slice('../Image/'.length);
      else if (source.startsWith('Image/')) path = source.slice('Image/'.length);
      else if (activePath) path = zipPath(activePath.slice(0, activePath.lastIndexOf('/') + 1), source.split('#')[0]);
      return previewAssetForPath(path)?.url || source;
  };
  const hydrateResourceImages = (rootNode, chapterIndex = activeChapterIndex()) => {
    rootNode.querySelectorAll('img[src], image[href], image[xlink\\:href]').forEach((image) => {
      const attribute = image.hasAttribute('src') ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
      // Keep the packaged EPUB reference next to the rendered element. The
      // blob URL is strictly a view concern and must never become source XHTML.
      const source = image.getAttribute('data-epub-original-src') || image.getAttribute(attribute);
      const resolved = resolveResourceUrl(source, chapterIndex);
      if (resolved !== source) {
        image.setAttribute('data-epub-original-src', source);
        image.setAttribute(attribute, resolved);
      }
    });
  };
  new MutationObserver(hydratePreviewAssets).observe(preview, { childList:true, subtree:true });
  const imageInput = $('#image');
  const assetRecovery = document.createElement('p');
  assetRecovery.className = 'asset-recovery';
  assetRecovery.hidden = true;
  const assetRecoveryText = document.createElement('span');
  const assetRetryButton = document.createElement('button');
  assetRetryButton.type = 'button';
  assetRetryButton.textContent = '이미지 다시 불러오기';
  assetRecovery.append(assetRecoveryText, assetRetryButton);
  $('#assetList').after(assetRecovery);
  const renderAssetRecovery = () => {
    assetRecovery.hidden = unresolvedAssets.size === 0;
    assetRecoveryText.textContent = unresolvedAssets.size ? `이미지 ${unresolvedAssets.size}개를 불러오지 못했습니다. 자산 정보는 보존됩니다. ` : '';
  };
  const renderAssetShelf = () => {
    const list = $('#assetList');
    Array.from(list.children).forEach(row => { if (!previewAssets.has(row.dataset.assetName) || previewAssets.get(row.dataset.assetName) !== row.asset) row.remove(); });
    previewAssets.forEach((asset, name) => {
      if (Array.from(list.children).some(row => row.dataset.assetName === name)) return;
      const item = document.createElement('li');
      item.dataset.assetName = name;
      item.asset = asset;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'draft-item';
      button.textContent = name;
      button.title = `${name} 미리보기`;
      button.addEventListener('click', () => {
        preview.replaceChildren();
        const image = document.createElement('img');
        image.src = asset.url;
        image.alt = name;
        preview.append(image);
      });
      item.className = 'asset-row';
      const insert = document.createElement('button');
      insert.type = 'button';
      insert.className = 'asset-insert';
      insert.append(lucideElement(Plus,{width:15,height:15,'aria-hidden':'true'}));
      insert.setAttribute('aria-label',`${name} 본문 삽입`);
      insert.title = '현재 커서 위치에 이미지 삽입';
      insert.addEventListener('click', () => insertImageTag(name));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'asset-rename';
      rename.append(lucideElement(Pencil,{width:15,height:15,'aria-hidden':'true'}));
      rename.title = '이미지 관리';
      rename.setAttribute('aria-label',`${name} 관리`);
      rename.setAttribute('aria-expanded','false');
      const actions = document.createElement('div'); actions.className = 'asset-actions'; actions.hidden = true;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '이름변경';
      actions.append(remove,edit);
      rename.addEventListener('click', () => { actions.hidden = !actions.hidden; rename.setAttribute('aria-expanded',String(!actions.hidden)); });
      remove.addEventListener('click', () => {
        try { deleteAsset(name); } catch (error) { setStatus(`이미지 삭제 실패: ${error.message}`, 'error'); }
      });
      edit.addEventListener('click', () => {
        if (item.querySelector('.asset-name-input')) return;
        const input = document.createElement('input'); input.className = 'asset-name-input'; input.value = name;
        input.setAttribute('aria-label','이미지 파일명'); button.replaceWith(input);
        let finished = false;
        const finish = save => {
          if (finished) return;
          finished = true;
          if (!input.isConnected || previewAssets.get(name) !== asset) return;
          if (!save) { input.replaceWith(button); rename.focus(); return; }
          try { renameAsset(name,input.value); if (input.isConnected) input.replaceWith(button); }
          catch (error) { finished = false; input.setCustomValidity(error.message); input.reportValidity(); input.focus(); }
        };
        input.addEventListener('input', () => input.setCustomValidity(''));
        input.addEventListener('keydown', event => {
          if (event.isComposing) return;
          if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter'); }
        });
        input.addEventListener('blur', () => finish(true));
        input.focus(); input.setSelectionRange(0,name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length);
      });
      item.append(button, insert, rename, actions);
      list.append(item);
    });
  };
  imageInput.onchange = async (event) => {
    const projectChapters = bookProject.chapters;
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      const asset = await toPreviewAsset(file);
      if (bookProject.chapters !== projectChapters) { revokePreviewAssetUrl(asset); return; }
      const name = uniqueAssetName(file.name);
      if (importedEpub) {
        const imported = importedEpub;
        const bytes = new Uint8Array(await asset.blob.arrayBuffer());
        if (bookProject.chapters !== projectChapters || importedEpub !== imported) { revokePreviewAssetUrl(asset); return; }
        asset.originalPath = `${imported.packageBase}Image/${name}`;
        if (imported.files.has(asset.originalPath)) { revokePreviewAssetUrl(asset); setStatus('같은 이미지 경로가 이미 있습니다.', 'error'); continue; }
        imported.files.set(asset.originalPath,bytes);
        imported.manifest.push({id:`image-${crypto.randomUUID()}`,href:asset.originalPath,rawHref:relativeEpubPath(imported.packagePath,asset.originalPath),type:asset.type,properties:''});
      }
      previewAssets.set(name, asset);
      bookProject.dirty = true; bookProject.revision++;
    }
    renderAssetShelf();
    hydrateResourceImages(visualEditor);
    schedulePreview();
    event.target.value = '';
  };
  coverInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const cover = bookProject.chapters.find(chapter => chapter.type === 'cover');
    if (!cover) return;
    const asset = await toPreviewAsset(file);
    if (!bookProject.chapters.includes(cover)) { URL.revokeObjectURL(asset.url); return; }
    const name = uniqueAssetName(file.name || 'cover.png');
    previewAssets.forEach((existing) => { existing.isCover = false; });
    previewAssets.set(name, { ...asset, originalPath:'', isCover:true });
    coverPreview.src = asset.url;
    coverPreview.hidden = false;
    if (importedEpub) importedEpub.coverReplaced = true;
    if (cover) {
      bookProject.update(cover.id, { xhtml:cover.originalPath && importedEpub?.coverImagePath ? cover.xhtml : `<p><img src="../Image/${name}" alt="표지" /></p>` });
      if (isCoverSelected()) { setCurrentChapter(cover); openCoverReadOnly(); showCoverPreview(); }
    }
    renderAssetShelf();
    event.target.value = '';
  });
  const visualEditor = document.createElement('div');
  visualEditor.className = 'rich-editor';
  visualEditor.setAttribute('aria-label', '일반 편집기');
  visualEditor.hidden = true;
  const visualReadOnlyNotice = document.createElement('p');
  visualReadOnlyNotice.className = 'visual-read-only-notice';
  visualReadOnlyNotice.textContent = '이 장에는 일반편집이 보존할 수 없는 XHTML 요소나 속성이 있어 읽기 전용입니다. XHTML편집에서 안전하게 수정할 수 있습니다.';
  visualReadOnlyNotice.setAttribute('role', 'status');
  visualReadOnlyNotice.hidden = true;
  // 일반편집은 Tiptap이 준비되면 그 문서 모델을 사용한다. textarea는 XHTML
  // 모드·저장·EPUB 내보내기와 호환되는 HTML 브리지로 계속 유지한다.
  let tiptapEditor = null;
  let editorTools = null;
  let suppressTiptapUpdate = false;
  let visualLoadedChapterId = null;
  let visualBaseline = '';
  const getVisualHtml = () => tiptapEditor ? tiptapEditor.getHTML() : '';
  const setVisualHtml = (html) => {
    editorTools?.close();
    suppressTiptapUpdate = true;
    try {
      if (tiptapEditor) {
        tiptapEditor.commands.setContent(projectXhtmlForVisual(html || '',{preserveWhitespace:/white-space\s*:/i.test(cssEditor.value)}), false, {preserveWhitespace:'full'});
        let issue = null;
        try { issue = !html ? null : xhtmlPreservationIssue(html, serializeVisualXhtml(tiptapEditor.getHTML()), {preserveWhitespace:/white-space\s*:/i.test(cssEditor.value)}); }
        catch(error) { issue = `XHTML 변환을 검증할 수 없어 읽기 전용으로 열었습니다: ${error.message}`; }
        const safe = !issue;
        visualReadOnlyNotice.textContent = issue ? `${issue} XHTML편집에서 원문을 수정할 수 있습니다.` : '';
        tiptapEditor.setEditable(safe && document.documentElement.dataset.projectEditAccess !== 'readonly');
        visualReadOnlyNotice.hidden = safe || visualEditor.hidden;
      }
      // Tiptap mounts its document inside this element. Never seed sibling
      // markup here while its asynchronous modules load: that markup would
      // survive every subsequent setContent() and look like fixed body text.
      else visualEditor.replaceChildren();
      // 렌더링용 Object URL은 Tiptap document/BookProject에 쓰지 않는다.
      hydrateResourceImages(visualEditor, activeChapterIndex());
      visualLoadedChapterId = bookProject.selectedChapterId;
      visualBaseline = getVisualHtml();
    } finally { suppressTiptapUpdate = false; }
  };
  let lastVisualRange = null;
  const refreshVisualSelectionHighlight = () => {
    const registry = window.CSS?.highlights;
    if (!registry || typeof window.Highlight !== 'function') return;
    registry.delete('epub-visual-selection');
    if (!lastVisualRange || lastVisualRange.collapsed || !visualEditor.contains(lastVisualRange.commonAncestorContainer)) return;
    try { registry.set('epub-visual-selection', new window.Highlight(lastVisualRange.cloneRange())); }
    catch { /* 선택 범위가 DOM 변경으로 무효화된 경우 다음 선택에서 다시 만든다. */ }
  };
  const rememberVisualRange = () => {
    // ProseMirror owns the selection of the mounted rich editor. Keeping a
    // second DOM Range for it makes a toolbar click restore stale positions
    // after a save or document transaction. The native range is only a
    // fallback while the editor module is unavailable.
    if (tiptapEditor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    // 툴바 input을 누른 뒤에는 브라우저 selection이 input으로 옮겨간다. 이때
    // 본문의 드래그 범위를 덮어쓰면 단락 전체 fallback이 실행된다.
    if (range && visualEditor.contains(range.commonAncestorContainer)) {
      lastVisualRange = range.cloneRange();
      refreshVisualSelectionHighlight();
    }
  };
  const restoreVisualRange = () => {
    if (tiptapEditor) {
      tiptapEditor.commands.focus();
      return tiptapEditor.state.selection;
    }
    if (!lastVisualRange || !visualEditor.contains(lastVisualRange.commonAncestorContainer)) return null;
    const selection = window.getSelection();
    visualEditor.focus();
    selection.removeAllRanges();
    selection.addRange(lastVisualRange);
    refreshVisualSelectionHighlight();
    return selection.getRangeAt(0);
  };
  const storedVisualRange = () => (
    !tiptapEditor && lastVisualRange && visualEditor.contains(lastVisualRange.commonAncestorContainer)
      ? lastVisualRange.cloneRange()
      : null
  );
  document.addEventListener('selectionchange', () => {
    if (tiptapEditor) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (visualEditor.contains(range.commonAncestorContainer)) {
      lastVisualRange = range.cloneRange();
      refreshVisualSelectionHighlight();
    }
  });
  const keepVisualSelection = (firstNode, lastNode = firstNode) => {
    if (!firstNode || !lastNode) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartBefore(firstNode);
    range.setEndAfter(lastNode);
    selection.removeAllRanges();
    selection.addRange(range);
    lastVisualRange = range.cloneRange();
    refreshVisualSelectionHighlight();
  };
  const wrapVisualSelection = (range, styles) => {
    if (!range || range.collapsed) return null;
    const wrapper = document.createElement('span');
    Object.entries(styles).forEach(([property, value]) => wrapper.style.setProperty(property, value));
    try {
      // extractContents는 선택한 텍스트와 그 안의 인라인 서식만 꺼낸다. 따라서
      // 문단 전체를 건드리지 않고 선택 영역만 새 span으로 감쌀 수 있다.
      const contents = range.extractContents();
      wrapper.append(contents);
      range.insertNode(wrapper);
      return wrapper;
    } catch {
      return null;
    }
  };
  const exactSelectedStyleSpan = (range) => Array.from(visualEditor.querySelectorAll('span[style]')).find((span) => {
    const spanRange = document.createRange();
    spanRange.selectNode(span);
    return range.compareBoundaryPoints(Range.START_TO_START, spanRange) === 0
      && range.compareBoundaryPoints(Range.END_TO_END, spanRange) === 0;
  }) || null;
  const applyVisualSelectionStyle = (range, property, value) => {
    const selectedSpan = exactSelectedStyleSpan(range);
    const target = selectedSpan || wrapVisualSelection(range, { [property]:value });
    if (!target) return null;
    target.style.setProperty(property, value);
    // 같은 범위에 색상/크기를 반복 적용했을 때 이전 span 선언을 남기지 않는다.
    // 다른 속성(굵게, 기울임 등)은 유지한다.
    target.querySelectorAll('span[style]').forEach((child) => {
      child.style.removeProperty(property);
      if (!child.getAttribute('style')?.trim() && child.attributes.length === 0) child.replaceWith(...child.childNodes);
    });
    return target;
  };
  const materialiseVisualSelection = () => {
    const range = storedVisualRange();
    if (!range || range.collapsed) return null;
    const existing = exactSelectedStyleSpan(range);
    if (existing) return existing;
    const span = wrapVisualSelection(range, {});
    if (!span) return null;
    // style 속성을 남겨 이후 같은 선택 범위를 정확히 찾아 font-size만 교체한다.
    span.setAttribute('style', '');
    keepVisualSelection(span);
    return span;
  };
  const insertImageTag = (name) => {
    const asset = previewAssets.get(name);
    const activePath = bookProject.selectedChapter?.originalPath;
    // Imported EPUB assets retain their ZIP path.  Generate only the relative
    // reference needed by the currently-open XHTML document.
    const source = asset?.originalPath && activePath
      ? relativeEpubPath(activePath, asset.originalPath)
      : `../Image/${name}`;
    const markup = `<img src="${source.split('/').map(encodeURIComponent).join('/')}" alt="" />`;
    if (visualEditor.hidden) {
      const monacoEditor = window.epubMonacoEditor;
      if (monacoEditor?.getModel()) {
        const selection = monacoEditor.getSelection() || new window.monaco.Selection(1, 1, 1, 1);
        const model = monacoEditor.getModel();
        const offset = model.getOffsetAt(selection.getStartPosition());
        monacoEditor.executeEdits('insert-epub-image', [{ range:selection, text:markup }]);
        const position = model.getPositionAt(offset + markup.length);
        monacoEditor.setPosition(position);
        monacoEditor.setSelection(new window.monaco.Selection(position.lineNumber, position.column, position.lineNumber, position.column));
        monacoEditor.focus();
        return;
      }
      htmlEditor.setRangeText(markup, htmlEditor.selectionStart, htmlEditor.selectionEnd, 'end');
      htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
      htmlEditor.focus();
      return;
    }
    if (tiptapEditor) {
      tiptapEditor.chain().focus().insertContent(markup).run();
      syncFromVisual();
      refreshPreview();
      return;
    }
    visualEditor.focus();
    if (lastVisualRange) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(lastVisualRange);
    }
    document.execCommand('insertHTML', false, markup);
    syncFromVisual();
    refreshPreview();
  };
  const assetReferencePlan = (name, nextPath) => {
    const target = imageAssetPath(name,previewAssets.get(name));
    const chapters = bookProject.chapters.map(chapter => ({
      chapter, ...imageReferences(chapter.xhtml,chapter.originalPath || `EPUB/text/${chapter.fileName || 'chapter.xhtml'}`,target,{nextPath}),
    }));
    const cssPath = importedEpub?.stylesheetPath || 'EPUB/styles/book.css';
    const css = imageReferences(cssEditor.value,cssPath,target,{nextPath,css:true});
    const notesPage = bookProject.chapters.find(chapter => chapter.type === 'footnotes' && chapter.generated);
    const notes = notesPage ? Array.from(footnotes.values(), note => ({note,...imageReferences(note.content,
      notesPage.originalPath || `EPUB/text/${notesPage.fileName}`,target,{nextPath})})) : [];
    const files = [];
    if (importedEpub) for (const [path,bytes] of importedEpub.files) {
      if (!/\.(?:xhtml|html|svg|css|opf|ncx)$/i.test(path)) continue;
      const original = zipText(bytes);
      files.push({path,original,...imageReferences(original,path,target,{nextPath,css:path.endsWith('.css')})});
    }
    return {target,chapters,css,files,notes};
  };
  const noteRemovedAsset = name => {
    if (!bookProject.removedAssetNames.includes(name)) bookProject.removedAssetNames.push(name);
    bookProject.dirty = true; bookProject.revision++;
  };
  const deleteAsset = name => {
    const asset = previewAssets.get(name);
    if (!asset) return;
    saveCurrentChapter();
    const plan = assetReferencePlan(name);
    const locations = plan.chapters.filter(item => item.hits.length).map(({chapter,hits}) =>
      `${chapter.title || chapter.fileName || '제목 없는 장'} — 본문 XHTML ${[...new Set(hits.map(offset => chapter.xhtml.slice(0,offset).split('\n').length))].join(', ')}행 (${hits.length}회)`);
    if (plan.css.hits.length) locations.push(`공통 CSS (${plan.css.hits.length}회)`);
    const chapterPaths = new Set(bookProject.chapters.map(chapter => chapter.originalPath));
    plan.files.filter(file => file.hits.length && file.path !== importedEpub?.packagePath && file.path !== importedEpub?.stylesheetPath)
      .forEach(file => {
        const body = chapterPaths.has(file.path) && sourceElements(file.original).find(node => node.tag === 'body');
        const hits = body ? file.hits.filter(offset => offset < body.start || offset >= body.end) : file.hits;
        if (hits.length) locations.push(`${file.path}${body ? ' 문서 헤더' : ''} (${hits.length}회)`);
      });
    if (coverPreview.getAttribute('src') === asset.url) locations.push('표지 이미지');
    if (locations.length && !window.confirm(`“${name}” 이미지가 사용 중입니다.\n\n${locations.join('\n')}\n\n삭제하면 해당 위치의 이미지가 표시되지 않을 수 있습니다. 본문은 유지됩니다. 삭제할까요?`)) return;
    previewAssets.delete(name);
    if (asset.originalPath && importedEpub) {
      importedEpub.files.delete(asset.originalPath);
      const removedId = importedEpub.manifest.find(item => item.href === asset.originalPath)?.id;
      importedEpub.manifest = importedEpub.manifest.filter(item => item.href !== asset.originalPath);
      if (importedEpub.coverImagePath === asset.originalPath) {
        importedEpub.coverImagePath = '';
        const extras = importedEpub.metadataExtras || '';
        const nodes = sourceElements(extras).filter(node => node.tag === 'meta' && sourceAttribute(node,'name') === 'cover' && sourceAttribute(node,'content') === removedId);
        importedEpub.metadataExtras = nodes.sort((a,b) => b.start-a.start).reduce((source,node) => source.slice(0,node.start)+source.slice(node.end),extras);
      }
    }
    if (coverPreview.getAttribute('src') === asset.url) { coverPreview.removeAttribute('src'); coverPreview.hidden = true; }
    noteRemovedAsset(name);
    revokePreviewAssetUrl(asset);
    // Discard old hydrated blob URLs without changing the canonical XHTML.
    if (!visualEditor.hidden) setVisualHtml(bookProject.selectedChapter?.xhtml || '');
    renderAssetShelf(); refreshPreview();
    if (isCoverSelected()) openCoverReadOnly();
    setStatus(`“${name}” 이미지를 삭제했습니다. 저장하면 서버 저장본에도 반영됩니다.`);
  };
  const renameAsset = (oldName, requested) => {
    if (!requested.trim()) throw new Error('파일명을 입력하세요.');
    const extension = oldName.includes('.') ? oldName.slice(oldName.lastIndexOf('.')) : '';
    const nextName = uniqueAssetName(requested.includes('.') ? requested : `${requested}${extension}`, oldName);
    if (nextName === oldName) return;
    const asset = previewAssets.get(oldName);
    if (!asset) return;
    saveCurrentChapter();
    const oldPath = imageAssetPath(oldName,asset);
    const nextPath = oldPath.slice(0,oldPath.lastIndexOf('/')+1) + nextName;
    if (importedEpub?.files.has(nextPath)) throw new Error('같은 경로의 파일이 이미 있습니다. 다른 이름을 입력하세요.');
    const plan = assetReferencePlan(oldName,nextPath);
    // Prepare all parser edits before applying any changes.
    const metas = importedEpub?.chapterMeta.map(meta => ({...meta,
      source:imageReferences(meta.source,meta.path,oldPath,{nextPath}).source,
      body:imageReferences(meta.body,meta.path,oldPath,{nextPath}).source,
    }));
    plan.chapters.forEach(({chapter,source}) => { if (source !== chapter.xhtml) bookProject.update(chapter.id,{xhtml:source}); });
    plan.notes.forEach(({note,source}) => { note.content = source; });
    if (plan.css.source !== cssEditor.value) { cssEditor.value = plan.css.source; cssEditor.dispatchEvent(new Event('input',{bubbles:true})); }
    if (importedEpub) {
      plan.files.forEach(file => { if (file.source !== file.original) importedEpub.files.set(file.path,epubText(file.source)); });
      importedEpub.chapterMeta = metas;
      if (asset.originalPath) {
        importedEpub.files.set(nextPath,importedEpub.files.get(oldPath)); importedEpub.files.delete(oldPath);
        importedEpub.manifest.forEach(item => { if (item.href === oldPath) { item.href = nextPath; item.rawHref = relativeEpubPath(importedEpub.packagePath,nextPath); } });
        if (importedEpub.coverImagePath === oldPath) importedEpub.coverImagePath = nextPath;
      }
    }
    previewAssets.delete(oldName);
    if (asset.originalPath) asset.originalPath = nextPath;
    previewAssets.set(nextName, asset);
    noteRemovedAsset(oldName);
    if (bookProject.selectedChapter) setCurrentChapter(bookProject.selectedChapter);
    renderAssetShelf();
    refreshPreview();
    setStatus(`“${nextName}”으로 이름을 변경했습니다. 저장하면 서버 저장본에도 반영됩니다.`);
  };
  const richToolbar = document.createElement('div');
  richToolbar.className = 'rich-toolbar';
  richToolbar.hidden = true;
  richToolbar.innerHTML = `
    <button type="button" data-editor-action="undo" title="되돌리기 (Ctrl/Cmd+Z)" aria-label="되돌리기" disabled>↶</button><button type="button" data-editor-action="redo" title="다시 실행 (Ctrl/Cmd+Shift+Z)" aria-label="다시 실행" disabled>↷</button>
    <button type="button" data-command="bold" title="굵게"><b>B</b></button>
    <button type="button" data-command="italic" title="기울임"><i>I</i></button>
    <button type="button" data-command="superscript" title="위첨자">x<sup>2</sup></button>
    <button type="button" data-command="subscript" title="아래첨자">x<sub>2</sub></button>
    <span class="tool-separator"></span>
    <select data-heading aria-label="제목 단계"><option value="">본문</option><option value="h1">제목 1</option><option value="h2">제목 2</option><option value="h3">제목 3</option><option value="h4">제목 4</option><option value="h5">제목 5</option></select>
    <input data-font-size list="font-size-options" inputmode="numeric" aria-label="글자 크기" placeholder="기본" title="글자 크기 직접 입력">
    <datalist id="font-size-options"><option value="10"><option value="11"><option value="12"><option value="13"><option value="14"><option value="15"><option value="16"><option value="20"><option value="24"><option value="32"><option value="36"><option value="40"><option value="48"><option value="64"></datalist>
    <select data-font-family aria-label="글꼴"><option value="">기본 글꼴</option><option value="sans-serif">고딕</option><option value="serif">명조</option><option value="monospace">고정폭</option><option value="system-ui">기기 기본</option></select>
    <label title="글자색"><input type="color" value="#FF5100" aria-label="글자색"></label>
    <span class="tool-separator"></span>
    <button type="button" data-command="justifyLeft" title="왼쪽 정렬">≡</button>
    <button type="button" data-command="justifyCenter" title="가운데 정렬">≡</button>
    <button type="button" data-command="justifyRight" title="오른쪽 정렬">≡</button>
    <button type="button" data-command="justifyFull" title="양쪽 맞춤">☰</button>
    <span class="tool-separator"></span>
    <select data-list aria-label="목록 종류"><option value="">목록</option><option value="disc">• 글머리</option><option value="decimal">1. 숫자</option><option value="upper-roman">I. 로마</option></select>
    <button type="button" data-command="formatBlock" data-value="blockquote" title="인용" aria-label="인용"></button>
    <span class="tool-separator"></span>
    <span class="table-color-control"><span class="tool-label">헤더</span><input type="color" data-table-color="head" value="#ffffff" aria-label="표 헤더 배경색"></span>
    <span class="table-color-control"><span class="tool-label">본문</span><input type="color" data-table-color="body" value="#ffffff" aria-label="표 본문 배경색"></span>
  `;
  const textStylesUi = mountTextStyles({
    project:bookProject, toolbar:richToolbar, cssEditor,
    onError:message => setStatus(message, 'error'),
  });
  const mode = document.createElement('div');
  mode.className = 'editor-mode';
  mode.innerHTML = '<button type="button" data-mode-toggle aria-pressed="false">XHTML편집</button>';
  const chapterErrorAlert = document.createElement('button');
  chapterErrorAlert.type = 'button';
  chapterErrorAlert.className = 'editor-error-alert';
  chapterErrorAlert.hidden = true;
  chapterErrorAlert.setAttribute('aria-expanded', 'false');
  const chapterErrorPopover = document.createElement('section');
  chapterErrorPopover.className = 'chapter-error-popover editor-popover-motion';
  chapterErrorPopover.hidden = true;
  chapterErrorPopover.setAttribute('role', 'dialog');
  chapterErrorPopover.setAttribute('aria-label', '현재 장 XHTML 오류');
  document.body.append(chapterErrorPopover);
  let currentChapterErrors = [];
  const editorControls = document.createElement('div');
  editorControls.className = 'editor-controls';
  const toolbarViewport = document.createElement('div');
  for (const [selector, icon] of [['[data-value="blockquote"]', Quote]]) {
    richToolbar.querySelector(selector)?.append(lucideElement(icon, { 'aria-hidden':'true', width:15, height:15 }));
  }
  toolbarViewport.className = 'toolbar-viewport';
  const toolbarPrevious = document.createElement('button');
  toolbarPrevious.type = 'button';
  toolbarPrevious.className = 'toolbar-previous';
  toolbarPrevious.setAttribute('aria-label', '이전 편집 도구 보기');
  toolbarPrevious.hidden = true;
  toolbarPrevious.append(lucideElement(ChevronLeft, {width:17,height:17,'aria-hidden':'true'}));
  const toolbarNext = document.createElement('button');
  toolbarNext.type = 'button';
  toolbarNext.className = 'toolbar-next';
  toolbarNext.setAttribute('aria-label', '다음 편집 도구 보기');
  toolbarNext.hidden = true;
  toolbarNext.append(lucideElement(ChevronRight, {width:17,height:17,'aria-hidden':'true'}));
  toolbarViewport.append(richToolbar, toolbarPrevious, toolbarNext);
  editorControls.append(mode, chapterErrorAlert, toolbarViewport);
  editorFields.before(editorControls);
  editorFields.after(visualEditor);
  visualEditor.after(visualReadOnlyNotice);
  let coverReadOnly = null;
  const removeCoverReadOnly = () => {
    coverReadOnly?.remove();
    coverReadOnly = null;
  };
  const renderCoverReadOnly = () => {
    const source = coverPreview.getAttribute('src');
    removeCoverReadOnly();
    if (!isCoverSelected() || !htmlField.hidden) return;
    const view = document.createElement('div');
    view.className = 'cover-read-only-view';
    view.style.cssText = 'display:grid;grid-template-rows:minmax(0,1fr) auto;place-items:center;gap:12px;box-sizing:border-box;min-height:240px;height:min(560px,calc(100dvh - 320px));margin-top:12px;padding:12px;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);';
    const image = document.createElement('img');
    image.alt = '표지 이미지';
    if (source) image.src = source;
    image.style.cssText = 'display:block;min-width:0;min-height:0;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;';
    if (source) view.append(image);
    const upload = document.createElement('button');
    upload.type = 'button'; upload.className = 'secondary';
    upload.textContent = source ? '표지 변경' : '표지 선택';
    upload.addEventListener('click', () => coverInput.click());
    view.append(upload);
    visualEditor.after(view);
    coverReadOnly = view;
  };
  const chapterCharacterCount = document.createElement('output');
  chapterCharacterCount.className = 'chapter-character-count';
  chapterCharacterCount.style.cssText = 'display:block;margin-top:8px;color:var(--sub);font-size:14px;text-align:right;';
  editorActions.after(chapterCharacterCount);
  const updateChapterCharacterCount = () => {
    if (isCoverSelected()) { chapterCharacterCount.textContent = '표지 · 읽기 전용'; return; }
    const template = document.createElement('template');
    template.innerHTML = htmlEditor.value;
    chapterCharacterCount.textContent = `글자 수 ${template.content.textContent.length.toLocaleString()}자`;
  };
  const openCoverReadOnly = () => {
    editorFields.hidden = htmlField.hidden;
    editorControls.hidden = false;
    editorActions.hidden = false;
    visualEditor.hidden = true;
    richToolbar.hidden = true;
    visualReadOnlyNotice.hidden = true;
    window.epubMonacoEditor?.updateOptions({ readOnly:!bookProject.selectedChapter?.xhtml });
    renderCoverReadOnly();
  };
  const closeCoverReadOnly = () => {
    removeCoverReadOnly();
    window.epubMonacoEditor?.updateOptions({ readOnly:false });
    editorFields.hidden = false;
    editorControls.hidden = false;
    editorActions.hidden = false;
    const visual = htmlField.hidden;
    htmlField.hidden = visual;
    richToolbar.hidden = !visual;
    visualEditor.hidden = !visual;
    visualReadOnlyNotice.hidden = !visual || !tiptapEditor || tiptapEditor.isEditable;
    const toggle = mode.querySelector('[data-mode-toggle]');
    toggle.textContent = visual ? 'XHTML편집' : '일반편집';
    toggle.setAttribute('aria-pressed', String(!visual));
    if (!visual) void window.formatXhtmlMonacoForDisplay?.();
    updateChapterCharacterCount();
  };
  const chapterSearchPanel = document.createElement('section');
  chapterSearchPanel.className = 'chapter-search-panel editor-popover-motion';
  chapterSearchPanel.hidden = true;
  chapterSearchPanel.setAttribute('role', 'dialog');
  chapterSearchPanel.setAttribute('aria-label', '전체 장 검색 및 바꾸기');
  chapterSearchPanel.innerHTML = `<div class="chapter-search-head"><strong>전체 장 검색 · 바꾸기</strong><button type="button" class="chapter-search-close" aria-label="검색 패널 닫기">×</button></div><div class="chapter-search-fields"><input type="search" data-chapter-search placeholder="찾을 내용" aria-label="찾을 내용"><input type="text" data-chapter-replace placeholder="바꿀 내용" aria-label="바꿀 내용"></div><div class="chapter-search-actions"><button type="button" class="secondary" data-chapter-search-run>검색</button><button type="button" class="secondary" data-chapter-replace-all>모두 바꾸기</button></div><p class="chapter-search-summary" aria-live="polite">찾을 내용을 입력하세요.</p><ul class="chapter-search-results"></ul>`;
  document.body.append(chapterSearchPanel);
  const chapterSearchInput = chapterSearchPanel.querySelector('[data-chapter-search]');
  const chapterReplaceInput = chapterSearchPanel.querySelector('[data-chapter-replace]');
  const chapterSearchSummary = chapterSearchPanel.querySelector('.chapter-search-summary');
  const chapterSearchResults = chapterSearchPanel.querySelector('.chapter-search-results');
  let chapterSearchReturnFocus = null;
  const updateToolbarNavigation = () => {
    const maxScroll = Math.max(0, richToolbar.scrollWidth - richToolbar.clientWidth);
    const canGoPrevious = richToolbar.scrollLeft > 2;
    const canGoNext = maxScroll > 2 && richToolbar.scrollLeft < maxScroll - 2;
    toolbarPrevious.hidden = !canGoPrevious;
    toolbarNext.hidden = !canGoNext;
    toolbarViewport.classList.toggle('show-previous', canGoPrevious);
    toolbarViewport.classList.toggle('show-next', canGoNext);
  };
  const scrollToolbar = (direction) => {
    const pageWidth = Math.max(120, richToolbar.clientWidth - 84);
    const maxScroll = Math.max(0, richToolbar.scrollWidth - richToolbar.clientWidth);
    richToolbar.scrollTo({
      left: Math.max(0, Math.min(maxScroll, richToolbar.scrollLeft + direction * pageWidth)),
      behavior: 'smooth',
    });
  };
  toolbarPrevious.addEventListener('click', () => scrollToolbar(-1));
  toolbarNext.addEventListener('click', () => {
    scrollToolbar(1);
  });
  richToolbar.addEventListener('scroll', updateToolbarNavigation);
  new ResizeObserver(updateToolbarNavigation).observe(richToolbar);
  requestAnimationFrame(updateToolbarNavigation);

  let initializingWorkspace = true;
  let restoreEpoch = 0;
  let supabaseUser = initialAccess.user;
  const cloudReady = Promise.resolve(authClient);
  const accountButton = accountArea.querySelector('button.account-button');
  const accountPanel = accountArea.querySelector('.account-panel');
  const loginForm = accountArea.querySelector('.login-form');
  const adminForm = accountArea.querySelector('.admin-form');
  const accountMessage = accountArea.querySelector('.account-message');
  const adminPanel = accountArea.querySelector('.admin-panel');
  let memberAdminSettingsTab = null;
  let memberAdminSettingsPanel = null;
  const setAccountMessage = (message, error = false) => {
    accountMessage.textContent = message;
    accountMessage.classList.toggle('error', error);
  };
  const refreshAccountUi = async () => {
    const client = await cloudReady;
    if (!client || !supabaseUser) {
      loadAccountCssPresets(null);
      accountButton.textContent = '로그인';
      adminPanel.hidden = true;
      if (memberAdminSettingsTab) memberAdminSettingsTab.hidden = true;
      if (memberAdminSettingsPanel) memberAdminSettingsPanel.hidden = true;
      draftIndex = [];
      renderDrafts();
      return;
    }
    loadAccountCssPresets(supabaseUser.id);
    const username = initialAccess.profile.display_name || initialAccess.profile.username || supabaseUser.email?.split('@')[0] || '사용자';
    accountButton.textContent = `${username} · 로그아웃`;
    const targetId = supabaseUser.id;
    const { data, error } = await client.from('user_profiles').select('role,status').eq('user_id', targetId).maybeSingle();
    if (supabaseUser?.id !== targetId) return;
    const isApprovedAdmin = !error && data?.role === 'admin' && data?.status === 'approved';
    adminPanel.hidden = !isApprovedAdmin;
    if (memberAdminSettingsTab) memberAdminSettingsTab.hidden = !isApprovedAdmin;
    if (memberAdminSettingsPanel) memberAdminSettingsPanel.hidden = !isApprovedAdmin;
    await restoreCloudDrafts();
  };
  accountButton.addEventListener('click', async () => {
    if (supabaseUser) {
      await saveInFlight;
      if (!await confirmDiscardCurrent()) return;
      const client = await cloudReady;
      window.dispatchEvent(new Event('sitescout-identity-invalidated'));
      await client?.auth.signOut();
      supabaseUser = null;
      adminPanel.hidden = true;
      setAccountMessage('로그아웃했습니다.');
      await refreshAccountUi();
      bookProject.dirty = false;
      newBookButton.click();
      return;
    }
    window.location.assign('login/');
  });
  accountArea.querySelector('.account-close').addEventListener('click', () => { accountPanel.hidden = true; });
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(loginForm);
    const client = await cloudReady;
    if (!client) return setAccountMessage('Supabase에 연결할 수 없습니다.', true);
    try {
      const access = await signInApproved(client, form.get('username'), String(form.get('password')));
      supabaseUser = access.user;
    } catch (error) { return setAccountMessage(error.message || '로그인에 실패했습니다.', true); }
    await refreshAccountUi();
    accountPanel.hidden = true;
    setAccountMessage('로그인했습니다.');
    renderDrafts();
  });
  adminForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(adminForm);
    const client = await cloudReady;
    const { data, error } = await client.functions.invoke('account-admin', { body:{ username:form.get('username'), password:form.get('password'), action:'create' } });
    if (error || data?.error) return setAccountMessage(data?.error || error?.message || '아이디 발급에 실패했습니다.', true);
    adminForm.reset();
    setAccountMessage(`아이디 ${data.username}을(를) 발급했습니다.`);
  });
  const persistenceOwnerId = () => supabaseUser?.id || 'local';
  const deletionKey = (ownerId, projectId) => `${ownerId}:${projectId}`;
  // sessionStorage can be cloned into a duplicated/opener tab. A fresh ID for
  // this document prevents two live tabs from sharing one server lease.
  const projectClientId = crypto.randomUUID();
  let editLeaseSupported = true;
  let editLease = null;
  let leaseRenewTimer = null;
  const leaseNoticeKeys = new Set();
  const hasCurrentEditLease = () => Boolean(editLease && editLease.projectId === bookProject.projectId && editLease.expiresAt > Date.now());
  const rememberLease = (projectId, data) => {
    // Convert the server-issued interval to a local deadline. We never trust
    // the device clock as the authority; the RPC still checks server time.
    const leaseMs = Math.max(0,new Date(data.expires_at).getTime() - new Date(data.server_now).getTime());
    editLease = {projectId,generation:data.generation,expiresAt:Date.now() + leaseMs};
    clearInterval(leaseRenewTimer);
    leaseRenewTimer = setInterval(() => { void renewEditLease(); }, 15000);
  };
  const releaseEditLease = async () => {
    const lease = editLease;
    editLease = null;
    clearInterval(leaseRenewTimer); leaseRenewTimer = null;
    if (editLeaseSupported !== true || !lease || !supabaseUser || !isAccessVerified()) return;
    const client = await cloudReady;
    await client?.rpc('release_epub_project_edit_lock',{p_project_id:lease.projectId,p_client_id:projectClientId,p_generation:lease.generation});
  };
  const {loadDraftAssets, loadImportedSourceFiles, saveCloudDraft, deleteCloudDraft,
    readCloudProject, listCloudProjects} = createCloudDraftIo({
    cloudReady, persistenceOwnerId, deletionKey, projectClientId, assetHash,
    previewAssets, unresolvedAssets, revokePreviewAssetUrl, clearPreviewAssets,
    renderAssetShelf, renderAssetRecovery,
    ensureEditLease:(...args) => ensureEditLease(...args),
    renewEditLease:(...args) => renewEditLease(...args),
    get supabaseUser() { return supabaseUser; },
    get editLease() { return editLease; },
    get editLeaseSupported() { return editLeaseSupported; },
    get importedEpub() { return importedEpub; },
    get deletedProjectIds() { return deletedProjectIds; },
  });
  assetRetryButton.addEventListener('click', async () => {
    const ownerId = persistenceOwnerId();
    const title = openedDraftTitle;
    const epoch = restoreEpoch;
    assetRetryButton.disabled = true;
    try {
      for (const [name, metadata] of [...unresolvedAssets]) {
        if (epoch !== restoreEpoch || ownerId !== persistenceOwnerId() || title !== openedDraftTitle) return;
        let blob = null;
        if (!blob && supabaseUser) {
          const client = await cloudReady;
          for (const storagePath of await savedAssetPaths(ownerId, {title,projectId:bookProject.projectId}, metadata)) {
            const { data, error } = await client.storage.from('epub-assets').download(
              storagePath, { cacheNonce:metadata.hash || String(Date.now()) });
            if (!error && data && (!metadata.hash || await assetHash(data) === metadata.hash)) { blob = data; break; }
          }
        }
        if (!blob || epoch !== restoreEpoch || ownerId !== persistenceOwnerId()) continue;
        previewAssets.set(name, { ...metadata, blob, hash:metadata.hash || await assetHash(blob), url:URL.createObjectURL(blob) });
        unresolvedAssets.delete(name);
      }
      renderAssetShelf(); renderAssetRecovery(); refreshPreview();
      setStatus(unresolvedAssets.size ? `이미지 ${unresolvedAssets.size}개를 아직 불러오지 못했습니다.` : '이미지를 다시 불러왔습니다.', unresolvedAssets.size ? 'error' : 'ok');
    } catch (error) { setStatus(`이미지 재시도 실패: ${error.message}`, 'error'); }
    finally { assetRetryButton.disabled = false; }
  });
  const setProjectEditingAccess = (allowed, message = '') => {
    const locked = editLeaseSupported === true && !allowed;
    document.documentElement.dataset.projectEditAccess = locked ? 'readonly' : 'editable';
    takeEditButton.hidden = !locked;
    takeEditButton.disabled = !locked;
    // Navigation remains available; content-changing controls are made truly
    // inert for keyboard users as well as pointer users.
    for (const selector of ['#title','#author','#language','#ctitle','#clevel','#css','#body','#image','#coverInput','#sigilFileName','#add','#del','.draft-save','.asset-add','.asset-remove','.asset-rename','.rich-toolbar button','.rich-toolbar select','.rich-toolbar input','.editor-action-labeled']) {
      document.querySelectorAll(selector).forEach(element => {
        if (element === takeEditButton) return;
        element.disabled = locked || (element === draftButton && Boolean(saveInFlight));
        element.setAttribute('aria-readonly',String(locked));
      });
    }
    // The outer shell is never an editing host; Tiptap alone owns selection
    // and receives lease/read-only changes through its editor API.
    visualEditor.removeAttribute('contenteditable');
    tiptapEditor?.setEditable(!locked && !visualReadOnlyNotice.textContent);
    window.epubMonacoEditor?.updateOptions({readOnly:locked});
    if (!locked) updateToolbarState();
    if (locked && message) setStatus(message, 'error');
  };
  const ensureEditLease = async ({ takeover = false, quiet = false } = {}) => {
    if (!supabaseUser || !isAccessVerified() || !bookProject.projectId) return false;
    if (!navigator.onLine) { setProjectEditingAccess(false,'오프라인에서는 편집 권한을 확인할 수 없습니다. 현재 탭의 원고는 유지됩니다.'); return false; }
    const projectId = bookProject.projectId;
    const client = await cloudReady;
    const {data,error} = await client.rpc('claim_epub_project_edit_lock',{
      p_project_id:projectId,p_client_id:projectClientId,p_takeover:takeover,p_ttl_seconds:45,
    });
    if (projectId !== bookProject.projectId) return false;
    if (error) {
      setProjectEditingAccess(false,'편집 권한을 확인하지 못했습니다. 통신을 복구한 뒤 다시 확인하세요.');
      return false;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.granted !== 'boolean') {
      setProjectEditingAccess(false,'편집 권한 응답이 올바르지 않습니다. 통신을 복구한 뒤 다시 확인하세요.');
      return false;
    }
    if (!data?.granted) {
      editLease = null; clearInterval(leaseRenewTimer); leaseRenewTimer = null;
      setProjectEditingAccess(false, quiet ? '' : '다른 기기에서 편집 중입니다. 내용을 읽거나 “여기서 편집”으로 권한을 가져오세요.');
      return false;
    }
    rememberLease(projectId,data);
    setProjectEditingAccess(true);
    return true;
  };
  const renewEditLease = async () => {
    const lease = editLease;
    if (editLeaseSupported !== true || !lease || !supabaseUser || lease.projectId !== bookProject.projectId) return;
    if (!navigator.onLine) {
      setProjectEditingAccess(false,'통신이 끊겨 편집 권한을 잠갔습니다. 현재 탭의 원고는 유지됩니다.');
      return;
    }
    const client = await cloudReady;
    const {data,error} = await client.rpc('renew_epub_project_edit_lock',{
      p_project_id:lease.projectId,p_client_id:projectClientId,p_generation:lease.generation,p_ttl_seconds:45,
    });
    // A delayed renewal for an old generation must not revoke a newer claim
    // obtained after reconnect or an explicit transfer.
    if (bookProject.projectId !== lease.projectId || editLease?.generation !== lease.generation) return;
    if (!error && data?.granted) { rememberLease(lease.projectId,data); return; }
    editLease = null; clearInterval(leaseRenewTimer); leaseRenewTimer = null;
    setProjectEditingAccess(false,'편집 권한이 만료되었거나 다른 기기로 이전되었습니다. 현재 탭의 원고는 유지됩니다.');
    showLeaseNotice?.('권한이 다른 기기로 이전되었거나 만료되었습니다. 현재 탭의 원고를 내보내거나 권한을 다시 가져오세요.');
  };
  const draftButton = document.createElement('button');
  draftButton.type = 'button';
  draftButton.className = 'secondary';
  draftButton.textContent = '저장';
  editorActions.append(draftButton);
  const takeEditButton = document.createElement('button');
  takeEditButton.type = 'button'; takeEditButton.className = 'secondary';
  takeEditButton.textContent = '여기서 편집'; takeEditButton.hidden = true;
  editorActions.append(takeEditButton);
  const autoFixHtmlButton = document.createElement('button');
  autoFixHtmlButton.type = 'button';
  autoFixHtmlButton.className = 'secondary';
  autoFixHtmlButton.textContent = 'XHTML 자동수정';
  autoFixHtmlButton.title = '모든 장의 XHTML 빈 태그를 self-closing 형식으로만 수정합니다.';
  editorActions.prepend(autoFixHtmlButton);
  const proofreadButton = document.createElement('button');
  proofreadButton.type = 'button';
  proofreadButton.className = 'secondary';
  proofreadButton.textContent = '맞춤법 교정';
  proofreadButton.title = '현재 장의 텍스트만 Gemini로 교정합니다.';
  proofreadButton.setAttribute('aria-haspopup', 'dialog');
  autoFixHtmlButton.before(proofreadButton);
  setEditorActionIcon(draftButton,'Save','저장');
  setEditorActionIcon(autoFixHtmlButton,'CodeXml','XHTML 자동수정');
  setEditorActionIcon(proofreadButton,'SpellCheck','맞춤법 교정');
  const footnoteButton = document.createElement('button');
  footnoteButton.type = 'button';
  footnoteButton.className = 'footnote-insert';
  footnoteButton.title = '각주 삽입';
  footnoteButton.setAttribute('aria-label', '각주 삽입');
  footnoteButton.append(lucideElement(ListEnd, {width:15, height:15, 'aria-hidden':'true'}));
  richToolbar.querySelector('[data-editor-action="undo"]').after(footnoteButton);
  draftButton.classList.add('draft-save');
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'primary';
  importButton.textContent = '불러오기';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.epub,application/epub+zip,application/zip';
  importInput.hidden = true;
  document.body.append(importInput);
  const draftsPanel = document.createElement('div');
  draftsPanel.className = 'drafts-panel';
  const editorTab = side.querySelector('.tab[data-view="editorView"]');
  const newBookButton = document.createElement('button');
  newBookButton.type = 'button';
  newBookButton.className = 'new-book';
  newBookButton.textContent = '+';
  newBookButton.title = '새 전자책 만들기';
  newBookButton.setAttribute('aria-label', '새 전자책 만들기');
  editorTab?.parentElement.append(newBookButton);
  editorTab?.parentElement.insertAdjacentElement('afterend', draftsPanel);
  const fileActions = document.createElement('nav');
  fileActions.className = 'epub-file-actions';
  fileActions.setAttribute('aria-label', 'EPUB 파일');
  for (const [button, label, glyph] of [[newBookButton,'새 EPUB',FilePlus], [importButton,'불러오기',Upload], [exportButton,'내보내기',Download]]) {
    button.setAttribute('aria-label', label);
    button.title = label;
    button.replaceChildren(lucideElement(glyph, {width:16,height:16,'aria-hidden':'true'}), document.createTextNode(label));
    fileActions.append(button);
  }
  top.append(fileActions);
  let draftsExpanded = false;
  let openedDraftTitle = null;
  const deletedProjectIds = new Set();
  editorTab?.setAttribute('aria-expanded', 'false');
  editorTab?.addEventListener('click', (event) => {
    event.preventDefault();
    draftsExpanded = !draftsExpanded;
    editorTab.setAttribute('aria-expanded', String(draftsExpanded));
    renderDrafts();
  });
  let draftIndex = [];
  const getDrafts = () => draftIndex.map(draft => ({ ...draft }));
  const leaveDialog = document.createElement('dialog');
  leaveDialog.className = 'gemini-settings-dialog draft-delete-dialog';
  leaveDialog.setAttribute('aria-label','미저장 변경 이탈 확인');
  leaveDialog.innerHTML = '<div class="gemini-dialog-head"><h2>미저장 변경을 버릴까요?</h2></div><p class="delete-dialog-copy">현재 탭의 변경 사항은 서버에 저장되지 않았습니다. 이 화면을 떠나면 복구할 수 없습니다.</p><form method="dialog" class="gemini-dialog-footer"><button type="submit" value="cancel" class="secondary" data-close>계속 편집</button><button type="submit" value="leave" class="primary">변경 버리고 이동</button></form>';
  document.body.append(leaveDialog);
  const confirmDiscardCurrent = () => new Promise(resolve => {
    if (!bookProject.dirty && !saveInFlight) { resolve(true); return; }
    if (leaveDialog.open) { resolve(false); return; }
    leaveDialog.returnValue = '';
    leaveDialog.addEventListener('close',() => resolve(leaveDialog.returnValue === 'leave'),{once:true});
    openModal(leaveDialog,leaveDialog.querySelector('[data-close]'));
  });
  const statusToast = $('#status');
  let statusTimer = null;
  let statusFadeTimer = null;
  const clearStatusTimers = () => {
    clearTimeout(statusTimer);
    clearTimeout(statusFadeTimer);
  };
  const scheduleStatusDismissal = () => {
    clearStatusTimers();
    statusToast.classList.remove('is-leaving');
    statusTimer = setTimeout(() => {
      statusToast.classList.add('is-leaving');
      statusFadeTimer = setTimeout(() => {
        statusToast.textContent = '';
        statusToast.className = 'status';
      }, 300);
    }, 3000);
  };
  statusToast.addEventListener('mouseenter', clearStatusTimers);
  statusToast.addEventListener('mouseleave', () => {
    if (statusToast.classList.contains('ok') || statusToast.classList.contains('error')) scheduleStatusDismissal();
  });
  const setStatus = (message, type = 'ok') => {
    statusToast.textContent = message;
    statusToast.className = `status ${type}`;
    scheduleStatusDismissal();
  };
  const GEMINI_API_KEY_STORAGE = 'epub-gemini-api-key-v1';
  let sessionGeminiKey = '';
  try { localStorage.removeItem(GEMINI_API_KEY_STORAGE); } catch { /* No key is read. */ }
  const GEMINI_PROMPT_STORAGE = 'epub-gemini-proofread-prompt-v1';
  const DEFAULT_GEMINI_PROMPT = `한국어 맞춤법을 교정해 주세요.

원문의 의미와 문체는 유지하고,
맞춤법, 띄어쓰기, 표준 표기, 문장부호만 자연스럽게 교정해 주세요.

불필요한 문장 재작성이나 표현 개선은 하지 마세요.

교정된 본문만 반환하세요.`;
  const geminiSettingsDialog = document.createElement('dialog');
  geminiSettingsDialog.className = 'gemini-settings-dialog';
  geminiSettingsDialog.innerHTML = `<div class="gemini-dialog-head"><div><h2>설정</h2><p class="settings-description">작업 환경과 연결된 서비스를 관리하세요.</p></div><button type="button" data-close>닫기</button></div><div class="gemini-dialog-tabs"><button type="button" aria-current="page">API 설정</button></div><form class="gemini-settings-form"><label>Gemini API Key<input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="AIza…" /></label><label>기본 프롬프트<textarea name="prompt" spellcheck="false"></textarea></label><div><button type="button" data-restore>기본값 복원</button></div><div class="gemini-dialog-footer"><span>키는 현재 탭의 메모리에만 보관됩니다. 새로고침·로그아웃 후 다시 입력하세요.</span><button type="submit" class="primary">저장</button></div></form>`;
  document.body.append(geminiSettingsDialog);
  // focus-trap is the shared OSS primitive for settings dialogs and the mobile drawer.
  // Native dialog supplies the backdrop; focus-trap owns only keyboard containment.
  const modalTraps = new WeakMap();
  const openModal = (dialog, initialFocus) => {
    let trap = modalTraps.get(dialog);
    if (!trap) {
      dialog.tabIndex = -1;
      trap = createFocusTrap(dialog, {
        initialFocus:initialFocus || dialog.querySelector('[data-close]'), fallbackFocus:dialog,
        escapeDeactivates:false, allowOutsideClick:true, returnFocusOnDeactivate:false,
      });
      dialog.addEventListener('close', () => trap.deactivate());
      modalTraps.set(dialog, trap);
    }
    if (!dialog.open) dialog.showModal();
    trap.activate();
  };
  const geminiSettingsForm = geminiSettingsDialog.querySelector('form');
  geminiSettingsDialog.setAttribute('aria-label','Gemini API 설정');
  const apiFeedback = document.createElement('p');
  apiFeedback.className = 'settings-feedback'; apiFeedback.setAttribute('role','status');
  geminiSettingsForm.append(apiFeedback);
  const geminiApiKeyField = geminiSettingsForm.elements.apiKey;
  const geminiPromptField = geminiSettingsForm.elements.prompt;
  const readGeminiSettings = () => ({ apiKey:sessionGeminiKey, prompt:localStorage.getItem(`${GEMINI_PROMPT_STORAGE}:${persistenceOwnerId()}`) || DEFAULT_GEMINI_PROMPT });
  const openGeminiSettings = () => {
    const settings = readGeminiSettings();
    apiFeedback.textContent = '';
    geminiApiKeyField.value = settings.apiKey;
    geminiPromptField.value = settings.prompt;
    openModal(geminiSettingsDialog, geminiApiKeyField);
    geminiApiKeyField.focus();
  };
  geminiSettingsDialog.querySelector('[data-close]').addEventListener('click', () => geminiSettingsDialog.close());
  geminiSettingsForm.querySelector('[data-restore]').addEventListener('click', () => { geminiPromptField.value = DEFAULT_GEMINI_PROMPT; });
  geminiSettingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const apiKey = geminiApiKeyField.value.trim();
    if (!apiKey) { geminiApiKeyField.focus(); apiFeedback.textContent = 'Gemini API Key를 입력하세요.'; return; }
    try {
      sessionGeminiKey = apiKey;
      localStorage.setItem(`${GEMINI_PROMPT_STORAGE}:${persistenceOwnerId()}`, geminiPromptField.value.trim() || DEFAULT_GEMINI_PROMPT);
      geminiSettingsDialog.close(); setStatus('Gemini API 설정을 저장했습니다.');
    } catch { apiFeedback.textContent = 'API 설정 저장에 실패했습니다. 브라우저 저장 공간을 확인하세요.'; }
  });
  const settingsDialog = document.createElement('dialog');
  settingsDialog.className = 'gemini-settings-dialog app-settings-dialog';
  settingsDialog.setAttribute('aria-label', '설정');
  settingsDialog.innerHTML = `<div class="gemini-dialog-head"><div><h2>설정</h2><p class="settings-description">작업 환경과 연결된 서비스를 관리하세요.</p></div><button type="button" data-close>닫기</button></div>
    <div class="app-settings-shell"><nav class="app-settings-nav" aria-label="설정 메뉴" role="tablist" aria-orientation="vertical">
      <button type="button" data-settings-tab="general" role="tab" aria-selected="true">일반</button>
      <button type="button" data-settings-tab="members" role="tab" hidden>회원 관리</button>
    </nav><div class="app-settings-content">
      <section class="app-settings-panel" data-settings-panel="general"><h3>작업 환경</h3><p>자주 쓰는 작업실 환경을 이 브라우저에 저장합니다.</p><button type="button" class="api-settings-button">Gemini API 설정 <span aria-hidden="true">›</span></button><div class="theme-setting"><span>다크 테마</span><label class="theme-switch-label"><span>Light</span><input type="checkbox" role="switch" aria-label="다크 테마" class="theme-switch"><span>Dark</span></label></div></section>
      <section class="app-settings-panel" data-settings-panel="members" hidden><h3>회원 관리</h3><p>승인 대기 회원을 확인하고, 계정을 발급하거나 승인 상태를 관리합니다.</p><a class="member-admin-settings-link" href="admin/">회원 관리 열기 <span aria-hidden="true">›</span></a></section>
    </div></div>`;
  document.body.append(settingsDialog);
  memberAdminSettingsTab = settingsDialog.querySelector('[data-settings-tab="members"]');
  memberAdminSettingsPanel = settingsDialog.querySelector('[data-settings-panel="members"]');
  const selectSettingsPanel = (name) => {
    settingsDialog.querySelectorAll('[data-settings-tab]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.settingsTab === name));
      tab.tabIndex = tab.dataset.settingsTab === name ? 0 : -1;
    });
    settingsDialog.querySelectorAll('[data-settings-panel]').forEach(panel => {
      panel.hidden = panel.dataset.settingsPanel !== name;
    });
  };
  settingsDialog.querySelectorAll('[data-settings-tab]').forEach(tab => {
    tab.id = `settings-tab-${tab.dataset.settingsTab}`;
    tab.setAttribute('aria-controls', `settings-panel-${tab.dataset.settingsTab}`);
    const panel = settingsDialog.querySelector(`[data-settings-panel="${tab.dataset.settingsTab}"]`);
    panel.id = `settings-panel-${tab.dataset.settingsTab}`;
    panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',tab.id);
    tab.addEventListener('click', () => selectSettingsPanel(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...settingsDialog.querySelectorAll('[data-settings-tab]')].filter(item => !item.hidden);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (tabs.indexOf(tab) + (event.key === 'ArrowDown' ? 1 : tabs.length-1)) % tabs.length;
      selectSettingsPanel(tabs[index].dataset.settingsTab); tabs[index].focus();
    });
  });
  side.querySelector('.settings-button').addEventListener('click', () => {
    selectSettingsPanel('general');
    openModal(settingsDialog, settingsDialog.querySelector('[data-close]'));
  });
  settingsDialog.querySelector('[data-close]').addEventListener('click', () => settingsDialog.close());
  settingsDialog.querySelector('.api-settings-button').addEventListener('click', () => {
    settingsDialog.close(); openGeminiSettings();
  });
  const themeSwitch = settingsDialog.querySelector('.theme-switch');
  const syncThemeSwitch = () => { themeSwitch.checked = root.dataset.theme === 'dark'; };
  syncThemeSwitch();
  new MutationObserver(syncThemeSwitch).observe(root, {attributes:true, attributeFilter:['data-theme']});
  themeSwitch.addEventListener('change', () => {
    const theme = themeSwitch.checked ? 'dark' : 'light';
    root.dataset.theme = theme;
    localStorage.setItem('epub-theme', theme);
  });
  const geminiApiRequiredDialog = document.createElement('dialog');
  geminiApiRequiredDialog.className = 'gemini-settings-dialog';
  geminiApiRequiredDialog.innerHTML = '<div class="gemini-dialog-head"><h2>Gemini API 설정이 필요합니다</h2><button type="button" data-close>닫기</button></div><div class="gemini-dialog-footer"><span>현재 세션에 API Key를 입력하면 교정을 시작할 수 있습니다. 로그아웃하거나 새로고침하면 다시 입력해야 합니다.</span><button type="button" class="primary" data-open-settings>설정 열기</button></div>';
  document.body.append(geminiApiRequiredDialog);
  geminiApiRequiredDialog.querySelector('[data-close]').addEventListener('click', () => geminiApiRequiredDialog.close());
  geminiApiRequiredDialog.querySelector('[data-open-settings]').addEventListener('click', () => { geminiApiRequiredDialog.close(); openGeminiSettings(); });
  for (const dialog of [settingsDialog, geminiSettingsDialog, geminiApiRequiredDialog]) {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
  }
  const setCurrentChapter = (chapter) => {
    const index = activeChapterIndex();
    const selected = selectedChapterElement() || chapterList.querySelector('.chapter[data-i]');
    if (selected) {
      const id = chapter.id || ensureChapterId(selected);
      selected.dataset.chapterId = id;
      bookProject.selectedChapterId = id;
    }
    const next = {
      ...chapter,
      id:bookProject.selectedChapterId || chapter.id || selected?.dataset.chapterId || createChapterId(),
      title: chapter.title || '',
      level: Math.max(1, Math.min(3, Number(chapter.level) || 1)),
      body: chapter.xhtml ?? chapter.body ?? '',
      fileName: chapter.fileName || currentChapterFileName(index),
    };
    hydratingChapter = true;
    try {
      preview.dataset.chapterId = bookProject.selectedChapterId;
      visualEditor.dataset.chapterId = bookProject.selectedChapterId;
      codeEditor.dataset.chapterId = bookProject.selectedChapterId;
      chapterFileNames.set(index, next.fileName);
      $('#ctitle').value = next.title;
      $('#clevel').value = String(next.level);
      sigilFileName.value = next.fileName;
      htmlEditor.value = next.body;
      // 일반편집기가 숨겨진 XHTML 모드에서도 내부 Tiptap 문서를 함께 갱신한다.
      // 그렇지 않으면 나중에 일반편집으로 전환할 때 이전 장/기본 본문이 다시 보일 수 있다.
      setVisualHtml(next.body);
      // Update Monaco directly without a textarea input event.  Its own
      // synchronisation guard prevents the old model from being saved back.
      const monacoEditor = window.epubMonacoEditor;
      if (monacoEditor) window.loadXhtmlMonaco?.(next.body);
      if (!htmlField.hidden) void window.formatXhtmlMonacoForDisplay?.();
      upsertChapterAt(index, next);
      const chapterButton = chapterList.querySelector(`.chapter[data-i="${index}"]`);
      if (chapterButton) setChapterButtonLabel(chapterButton, next.title, index);
      updateChapterCharacterCount();
    } finally {
      hydratingChapter = false;
    }
  };
  const replaceProjectChapters = (chapters, selectedId, styles = {}) => {
    if (isCoverSelected()) closeCoverReadOnly();
    chapterList.replaceChildren();
    chapterFileNames.clear();
    parentTocMap.clear();
    tocExcluded.clear();
    bookProject.replace(chapters, selectedId, styles);
    textStylesUi.render();
    bookProject.chapters.forEach((chapter, index) => {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'chapter';
      row.dataset.i = String(index); row.dataset.chapterId = chapter.id;
      setChapterButtonLabel(row, chapter.title, index);
      chapterFileNames.set(index, chapter.fileName || defaultChapterFileName(index));
      bindManagedChapter(row); chapterList.append(row);
    });
    const selected = selectedChapterElement();
    if (selected) selectManagedChapter(Number(selected.dataset.i));
    else {
      $('#ctitle').value = '';
      htmlEditor.value = '';
      window.loadXhtmlMonaco?.('');
      setVisualHtml('');
      preview.replaceChildren();
      renderCoverReadOnly();
      updateChapterCharacterCount();
    }
  };
  const addSpecialChapter = (type, source = {}) => {
    const existing = bookProject.chapters.find(chapter => chapter.type === type);
    if (existing) return existing;
    const index = Math.max(-1, ...Array.from(chapterList.querySelectorAll('[data-i]'), row => Number(row.dataset.i))) + 1;
    const chapter = bookProject.add({ type, title:type === 'cover' ? '표지' : '각주 페이지', xhtml:'', fileName:type === 'cover' ? 'cover.xhtml' : 'footnote.xhtml', generated:true, ...source });
    const row = document.createElement('button'); row.type = 'button'; row.className = 'chapter';
    row.dataset.i = String(index); row.dataset.chapterId = chapter.id;
    setChapterButtonLabel(row, chapter.title, index); bindManagedChapter(row);
    chapterFileNames.set(index, chapter.fileName);
    if (!source.includeInToc) tocExcluded.add(index);
    if (type === 'cover') chapterList.prepend(row); else chapterList.append(row);
    return chapter;
  };
  newBookButton.addEventListener('click', async () => {
    if (!initializingWorkspace) {
      await saveInFlight;
      if (!await confirmDiscardCurrent()) return;
    }
    void releaseEditLease();
    setProjectEditingAccess(true);
    if (!initializingWorkspace) restoreEpoch++;
    importedEpub = null;
    footnotes.clear();
    chapterList.replaceChildren();
    bookProject.selectedChapterId = null;
    bookProject.replace([], null);
    chapterFileNames.clear();
    $('#ctitle').value = '';
    $('#clevel').value = '1';
    sigilFileName.value = '';
    htmlEditor.value = '';
    setVisualHtml('');
    $('#title').value = '';
    $('#author').value = '';
    $('#language').value = 'ko';
    hydrateCssValue('');
    textStylesUi.render();
    tocExcluded.clear();
    parentTocMap.clear();
    collapsedTocRoots.clear();
    clearPreviewAssets();
    renderAssetRecovery();
    openedDraftTitle = null;
    setEditorActionIcon(draftButton,'Save','저장');
    coverPreview.removeAttribute('src');
    coverPreview.hidden = true;
    const cover = addSpecialChapter('cover');
    addSpecialChapter('footnotes');
    selectManagedChapter(Number(chapterList.querySelector(`[data-chapter-id="${cover.id}"]`).dataset.i));
    renderAssetShelf();
    refreshChapterControls();
    refreshPreview();
    setStatus('새 전자책 편집을 시작했습니다.');
  });
  let collectingDraft = false;
  const syncOpenChapterEditor = () => {
    if (!visualEditor.hidden) {
      setVisualHtml(htmlEditor.value);
      return;
    }
    const monacoEditor = window.epubMonacoEditor;
    if (monacoEditor) window.loadXhtmlMonaco?.(htmlEditor.value);
    if (!htmlField.hidden) void window.formatXhtmlMonacoForDisplay?.();
  };
  const footnoteEscape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[character]));
  const createFootnoteId = () => {
    const token = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    return `fn-${token}`;
  };
  const attributeValue = (attributes, name) => new RegExp(`\\b${name.replace(':', '\\:')}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes)?.[2] || '';
  const footnoteReferencesIn = body => sourceElements(body)
    .filter(node => node.tag === 'a' && sourceAttribute(node, 'epub:type').split(' ').includes('noteref'))
    .map(node => ({ node, href:sourceAttribute(node, 'href'), target:sourceAttribute(node, 'href').split('#')[1] || '',
      referenceId:sourceAttribute(node, 'id'), generated:Boolean(sourceAttribute(node, 'data-sitescout-footnote')) }));
  const chapterPath = chapter => chapter.originalPath || `EPUB/text/${chapter.fileName}`;
  let syncingFootnotes = false;
  const synchronizeFootnotes = () => {
    if (syncingFootnotes) return;
    syncingFootnotes = true;
    try {
      let page = bookProject.chapters.find(chapter => chapter.type === 'footnotes' && chapter.generated);
      // Read the user's edited note content from the central page before rebuilding numbering.
      if (page && bookProject.selectedChapterId === page.id && !validateXhtml(page.xhtml).length) {
        const doc = new DOMParser().parseFromString(`<root xmlns:epub="http://www.idpf.org/2007/ops">${page.xhtml}</root>`, 'application/xml');
        for (const [id, note] of footnotes) {
          const aside = doc.getElementById(id) || Array.from(doc.getElementsByTagName('aside')).find(el => el.getAttribute('id') === id);
          const content = aside && Array.from(aside.getElementsByTagName('span')).find(el => el.getAttribute('data-footnote-content') === id);
          if (content) note.content = Array.from(content.childNodes, node => new XMLSerializer().serializeToString(node)).join('');
          // A noteref may be temporarily absent while its chapter is undone.
          // Keep its content until the redo branch can no longer use it.
        }
      }
      let number = 0; const referenced = new Set();
      const rows = Array.from(chapterList.querySelectorAll('.chapter[data-i]'));
      for (const row of rows) {
        const chapter = chapterAt(Number(row.dataset.i));
        if (!chapter || chapter.type === 'footnotes') continue;
        const edits = [];
        for (const ref of footnoteReferencesIn(chapter.xhtml)) {
          if (!ref.generated) continue; // imported annotations remain byte-preserved
          const note = footnotes.get(ref.target);
          if (!note) { edits.push({ start:ref.node.start, end:ref.node.end, replacement:'' }); continue; }
          if (!page) page = addSpecialChapter('footnotes');
          number++; referenced.add(note.id);
          Object.assign(note, { number, sourceChapterId:chapter.id, sourceFile:chapter.fileName, referenceId:ref.referenceId });
          const href = relativeEpubPath(chapterPath(chapter), chapterPath(page));
          const replacement = `<a epub:type="noteref" data-sitescout-footnote="${note.id}" href="${footnoteEscape(href)}#${note.id}" id="${note.referenceId}">[${number}]</a>`;
          if (chapter.xhtml.slice(ref.node.start, ref.node.end) !== replacement) edits.push({ start:ref.node.start, end:ref.node.end, replacement });
        }
        let next = chapter.xhtml;
        edits.sort((a,b) => b.start - a.start).forEach(edit => { next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end); });
        if (next !== chapter.xhtml) bookProject.update(chapter.id, { xhtml:next });
      }
      if (page) {
        const body = Array.from(footnotes.values()).filter(note => referenced.has(note.id)).sort((a,b) => a.number - b.number).map(note => {
          const source = bookProject.chapters.find(chapter => chapter.id === note.sourceChapterId);
          if (!source) return '';
          const href = relativeEpubPath(chapterPath(page), chapterPath(source));
          return `<aside epub:type="footnote" id="${note.id}"><p><a href="${footnoteEscape(href)}#${note.referenceId}">${note.number}.</a> <span data-footnote-content="${note.id}">${note.content}</span></p></aside>`;
        }).join('\n');
        const next = `<section epub:type="footnotes"><h1>각주</h1>${body}</section>`;
        if (page.xhtml !== next) bookProject.update(page.id, { xhtml:next });
      }
    } finally { syncingFootnotes = false; }
  };
  const prepareFootnotes = draft => {
    const errors = [];
    for (const chapter of draft.chapters) for (const ref of footnoteReferencesIn(chapter.body)) {
      if (ref.generated && !footnotes.has(ref.target)) errors.push({ chapter:chapter.id, message:`각주 대상 ${ref.target} 없음` });
    }
    const referenced = new Set(draft.chapters.flatMap(chapter => footnoteReferencesIn(chapter.body).filter(ref => ref.generated).map(ref => ref.target)));
    return { errors, notes:Array.from(footnotes.values()).filter(note => referenced.has(note.id)).sort((a,b) => a.number - b.number) };
  };
  footnoteButton.addEventListener('click', () => {
    if (!bookProject.selectedChapter || isCoverSelected() || bookProject.selectedChapter.type === 'footnotes') return;
    if (!visualEditor.hidden && !tiptapEditor?.isEditable) { setStatus('이 장은 XHTML 편집에서 각주를 삽입하세요.', 'error'); return; }
    const content = window.prompt('각주 내용을 입력하세요.');
    if (content === null) return;
    if (!content.trim()) { setStatus('각주 내용을 입력하세요.', 'error'); return; }
    const id = createFootnoteId();
    const referenceId = `ref-${id.slice(3)}`;
    const currentDraft = collectDraft();
    const number = currentDraft.chapters.reduce((total, chapter) => total + footnoteReferencesIn(chapter.body).length, 0) + 1;
    footnotes.set(id, { id, number, content:footnoteEscape(content), sourceChapterId:bookProject.selectedChapterId, sourceFile:currentChapterFileName(activeChapterIndex()), referenceId });
    const footnotePage = addSpecialChapter('footnotes');
    const href = relativeEpubPath(chapterPath(bookProject.selectedChapter), chapterPath(footnotePage));
    const markup = `<sup><a epub:type="noteref" data-sitescout-footnote="${id}" href="${footnoteEscape(href)}#${id}" id="${referenceId}">[${number}]</a></sup>`;
    if (visualEditor.hidden) {
      const monacoEditor = window.epubMonacoEditor;
      if (monacoEditor?.getModel()) {
        const selection = monacoEditor.getSelection();
        const model = monacoEditor.getModel();
        const offset = model.getOffsetAt(selection.getStartPosition());
        monacoEditor.executeEdits('insert-epub-footnote', [{ range:selection, text:markup }]);
        const position = model.getPositionAt(offset + markup.length);
        monacoEditor.setPosition(position);
        monacoEditor.focus();
      } else {
        htmlEditor.setRangeText(markup, htmlEditor.selectionStart, htmlEditor.selectionEnd, 'end');
        htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
        htmlEditor.focus();
      }
    } else if (tiptapEditor) {
      tiptapEditor.chain().focus().insertContent(markup).run();
      syncFromVisual({ normalise:false });
    } else {
      restoreVisualRange() || visualEditor.focus();
      document.execCommand('insertHTML', false, markup);
      syncFromVisual({ normalise:false });
    }
    snapshotCurrentChapter();
    synchronizeFootnotes();
    setStatus(`각주 ${number}을(를) 삽입했습니다.`);
  });
  const collectDraft = () => {
    saveCurrentChapter();
    synchronizeFootnotes();
    const activeSourceIndex = activeChapterIndex();
    const orderedIndexes = Array.from(chapterList.querySelectorAll('.chapter[data-i]')).map((chapter) => Number(chapter.dataset.i));
    const chapterLevel = index => {
      let level = 1, parent = parentTocMap.get(index);
      const seen = new Set([index]);
      while (parent !== undefined && !seen.has(parent)) { seen.add(parent); level++; parent = parentTocMap.get(parent); }
      return level;
    };
    const chapters = orderedIndexes.map((index) => {
      const snapshot = chapterAt(index);
      if (!snapshot) throw new Error(`제${index + 1}장의 저장 데이터를 찾을 수 없습니다.`);
      return {
        ...snapshot,
        id:snapshot.id || chapterList.querySelector(`.chapter[data-i="${index}"]`)?.dataset.chapterId || createChapterId(),
        title:snapshot.title,
        level:chapterLevel(index),
        body:snapshot.body,
        // File names are maintained independently for each chapter index.
        // Do not reuse a potentially stale editor snapshot here.
        fileName:currentChapterFileName(index),
        sourceIndex:index,
      };
    });
    return {
      projectId:bookProject.projectId,
      serverRevision:bookProject.serverRevision,
      localRevision:bookProject.localRevision,
      title: $('#title').value.trim(),
      author: $('#author').value,
      language: $('#language').value,
      css: $('#css').value,
      cssPresetId:bookProject.cssPresetId,
      typographyStyles:structuredClone(bookProject.typographyStyles),
      customStyles:structuredClone(bookProject.customStyles),
      removedAssetNames:[...bookProject.removedAssetNames],
      chapters,
      selectedChapterId:bookProject.selectedChapterId,
      activeIndex: Math.max(0, orderedIndexes.indexOf(activeSourceIndex)),
      tocExcluded: orderedIndexes.flatMap((sourceIndex, index) => tocExcluded.has(sourceIndex) ? [index] : []),
      parentToc: orderedIndexes.flatMap((sourceIndex, index) => {
        const parent = parentTocMap.get(sourceIndex);
        const parentIndex = parent === undefined ? -1 : orderedIndexes.indexOf(parent);
        return parentIndex >= 0 ? [[index, parentIndex]] : [];
      }),
      coverSource: coverPreview.getAttribute('src') || '',
      importedSource:importedSourcePayload(),
      footnotes: Array.from(footnotes.values()).filter(note => chapters.some(chapter => footnoteReferencesIn(chapter.body).some(ref => ref.generated && ref.target === note.id))).map((note) => ({ ...note })),
      assets: [...Array.from(previewAssets.entries()).map(([name, asset]) => ({
        name,
        type:asset.type,
        originalPath:asset.originalPath || '',
        isCover:Boolean(asset.isCover),
        hash:asset.hash, storagePath:asset.storagePath, serverStoredHash:asset.serverStoredHash,
      })), ...Array.from(unresolvedAssets, ([name, asset]) => ({ ...asset, name })).filter(asset => !previewAssets.has(asset.name))],
    };
  };
  const closeChapterSearch = () => {
    chapterSearchPanel.hidden = true;
    if (chapterSearchReturnFocus?.isConnected) chapterSearchReturnFocus.focus({preventScroll:true});
    chapterSearchReturnFocus = null;
  };
  const occurrencesInChapter = (body, query) => {
    if (!query) return [];
    const matches = [];
    let offset = 0;
    while (offset <= body.length - query.length) {
      const found = body.indexOf(query, offset);
      if (found < 0) break;
      matches.push(found);
      offset = found + Math.max(1, query.length);
    }
    return matches;
  };
  const chapterSearchState = { results:[] };
  const renderChapterSearchResults = (draft = collectDraft()) => {
    const query = chapterSearchInput.value;
    chapterSearchResults.replaceChildren();
    chapterSearchState.results = [];
    if (!query) {
      chapterSearchSummary.textContent = '찾을 내용을 입력하세요.';
      return;
    }
    draft.chapters.forEach((chapter, chapterIndex) => {
      occurrencesInChapter(chapter.body, query).forEach((offset) => {
        const line = chapter.body.slice(0, offset).split('\n').length;
        const context = chapter.body.slice(Math.max(0, offset - 28), offset + query.length + 46).replace(/\s+/g, ' ');
        chapterSearchState.results.push({ chapterIndex, offset, line, title:chapter.title || '제목 없는 장', context });
      });
    });
    const chapterCount = new Set(chapterSearchState.results.map((result) => result.chapterIndex)).size;
    chapterSearchSummary.textContent = chapterSearchState.results.length ? `${chapterCount}개 장에서 ${chapterSearchState.results.length}개 항목을 찾았습니다.` : '일치하는 내용이 없습니다.';
    chapterSearchState.results.forEach((result) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chapter-search-result';
      button.textContent = `${result.title} · ${result.line}행`;
      const detail = document.createElement('small');
      detail.textContent = result.context;
      button.append(detail);
      button.addEventListener('click', () => {
        saveCurrentChapter();
        chapterList.querySelector(`.chapter[data-i="${result.chapterIndex}"]`)?.click();
        if (!visualEditor.hidden) setMode('html');
        requestAnimationFrame(() => {
          const monacoEditor = window.epubMonacoEditor;
          const position = monacoEditor?.getModel()?.getPositionAt(result.offset);
          if (!position) return;
          monacoEditor.focus();
          monacoEditor.setPosition(position);
          monacoEditor.setSelection({ startLineNumber:position.lineNumber, startColumn:position.column, endLineNumber:position.lineNumber, endColumn:position.column });
          monacoEditor.revealPositionInCenter(position);
        });
      });
      item.append(button);
      chapterSearchResults.append(item);
    });
  };
  const replaceAllChapters = () => {
    const query = chapterSearchInput.value;
    if (!query) { chapterSearchSummary.textContent = '바꿀 내용을 먼저 입력하세요.'; return; }
    const draft = collectDraft();
    const replacement = chapterReplaceInput.value;
    const changed = draft.chapters.map((chapter, index) => {
      const count = occurrencesInChapter(chapter.body, query).length;
      return count ? { index, body:chapter.body.split(query).join(replacement), count } : null;
    }).filter(Boolean);
    if (!changed.length) { chapterSearchSummary.textContent = '바꿀 일치 항목이 없습니다.'; return; }
    const total = changed.reduce((sum, chapter) => sum + chapter.count, 0);
    if (!window.confirm(`${changed.length}개 장의 ${total}개 항목을 바꿉니다. 계속할까요?`)) return;
    collectingDraft = true;
    try {
      changed.forEach(({ index, body }) => {
        chapterList.querySelector(`.chapter[data-i="${index}"]`)?.click();
        htmlEditor.value = body;
        htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
      });
      chapterList.querySelector(`.chapter[data-i="${draft.activeIndex}"]`)?.click();
    } finally {
      collectingDraft = false;
      syncOpenChapterEditor();
    }
    chapterSearchSummary.textContent = `${changed.length}개 장의 ${total}개 항목을 바꿨습니다.`;
    renderChapterSearchResults();
    setStatus(`${changed.length}개 장의 ${total}개 항목을 바꿨습니다.`);
  };
  chapterSearchPanel.querySelector('.chapter-search-close').addEventListener('click', closeChapterSearch);
  chapterSearchPanel.querySelector('[data-chapter-search-run]').addEventListener('click', () => renderChapterSearchResults());
  chapterSearchPanel.querySelector('[data-chapter-replace-all]').addEventListener('click', replaceAllChapters);
  chapterSearchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') renderChapterSearchResults(); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (chapterSearchPanel.hidden) chapterSearchReturnFocus = document.activeElement;
      chapterSearchPanel.hidden = false;
      chapterSearchInput.focus();
      chapterSearchInput.select();
    }
    if (event.key === 'Escape' && !chapterSearchPanel.hidden) { event.preventDefault(); closeChapterSearch(); }
  }, true);
  const {epubText, epubEscape, createEpubZip, normaliseImportedFootnoteLinks, importedMetadata,
    makeEpubNav, replaceXhtmlBody, replaceXhtmlTitle, relativeEpubPath,
    zipText, zipPath, unzipEpub, xmlDocument, elementText, xhtmlBody, xhtmlTitle,
    tocEntriesFromNcx, tocEntriesFromNav} = createEpubFileIo({
    attributeValue, defaultChapterFileName, tocExcluded, parentTocMap,
  });
  const {exportAssetAwareEpub} = createEpubExporter({
    collectDraft, previewAssets, setStatus, prepareFootnotes, defaultChapterFileName,
    epubText, epubEscape, createEpubZip, normaliseImportedFootnoteLinks,
    replaceXhtmlBody, replaceXhtmlTitle, relativeEpubPath, importedMetadata, zipText, makeEpubNav,
    validateAllChapters:(...args) => validateAllChapters(...args),
    normaliseXhtml:(...args) => normaliseXhtml(...args),
    get importedEpub() { return importedEpub; },
  });
  exportButton.addEventListener('click', (event) => {
    if (!useAssetAwareExporter) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    exportAssetAwareEpub().catch((error) => setStatus(error.message || 'EPUB 파일을 만들지 못했습니다.', 'error'));
  }, true);
  const loadDraft = async (draft, request = projectOpenGeneration) => {
    if (!Array.isArray(draft?.chapters)) return false;
    if (editLease?.projectId && editLease.projectId !== draft.projectId) void releaseEditLease();
    const epoch = restoreEpoch;
    const revision = bookProject.revision;
    const ownerId = persistenceOwnerId();
    if (!draft.projectId) throw new Error('서버 원고 ID가 없습니다.');
    const isCurrent = () => request === projectOpenGeneration && epoch === restoreEpoch
      && revision === bookProject.revision && ownerId === persistenceOwnerId();
    if (!isCurrent()) return false;
    const stagedAssets = await loadDraftAssets(draft,isCurrent);
    if (!stagedAssets) return false;
    let stagedSource;
    try { stagedSource = await loadImportedSourceFiles(draft,isCurrent,stagedAssets.loaded); }
    catch (error) { stagedAssets.loaded.forEach(revokePreviewAssetUrl); throw error; }
    if (!isCurrent()) { stagedAssets.loaded.forEach(revokePreviewAssetUrl); return false; }
    clearPreviewAssets();
    stagedAssets.loaded.forEach((asset,name) => previewAssets.set(name,asset));
    stagedAssets.missing.forEach((asset,name) => unresolvedAssets.set(name,asset));
    importedEpub = stagedSource;
    renderAssetShelf(); renderAssetRecovery();
    footnotes.clear();
    setProjectEditingAccess(false);
    (draft.footnotes || []).forEach((note) => {
      if (note?.id && note?.referenceId) footnotes.set(note.id, { ...note });
    });
    replaceProjectChapters(draft.chapters, draft.selectedChapterId || draft.chapters[draft.activeIndex || 0]?.id, {...draft,...(draft.typographyStyles ? {} : stylesFromCss(draft.css || ''))});
    bookProject.removedAssetNames = [...new Set(draft.removedAssetNames || [])];
    $('#title').value = draft.title;
    openedDraftTitle = draft.title;
    setEditorActionIcon(draftButton,'Save','저장');
    $('#author').value = draft.author || '';
    $('#language').value = draft.language || 'ko';
    hydrateCssValue(draft.css || '');
    textStylesUi.render();
    tocExcluded.clear();
    (draft.tocExcluded || []).forEach((index) => tocExcluded.add(index));
    parentTocMap.clear();
    collapsedTocRoots.clear();
    (draft.parentToc || []).forEach(([child, parent]) => parentTocMap.set(Number(child), Number(parent)));
    const selectedChapter = Array.from(chapterList.querySelectorAll('.chapter[data-i]'))
      .find((chapter) => chapter.dataset.chapterId === draft.selectedChapterId);
    const selected = selectedChapter ? Number(selectedChapter.dataset.i) : Math.max(0, Math.min(draft.activeIndex || 0, draft.chapters.length - 1));
    selectManagedChapter(selected);
    refreshChapterControls();
    // blob: URL은 새로고침 뒤 무효가 된다. 가져온 표지는 저장한 이미지 자산에서
    // 새 object URL을 만들어 우선 복원하고, 직접 업로드한 data URL만 fallback으로 쓴다.
    const restoredCover = savedCoverAsset();
    const coverSource = restoredCover?.url || (!String(draft.coverSource || '').startsWith('blob:') ? draft.coverSource : '');
    if (coverSource) {
      coverPreview.src = coverSource;
      coverPreview.hidden = false;
    } else {
      coverPreview.removeAttribute('src');
      coverPreview.hidden = true;
    }
    if (!visualEditor.hidden) setVisualHtml(htmlEditor.value);
    refreshPreview();
    hydratePreviewAssets();
    const hydratedRevision = bookProject.revision;
    if (epoch === restoreEpoch && hydratedRevision === bookProject.revision) bookProject.dirty = false;
    // A project can be read without a lease. Claiming without takeover makes
    // this tab read-only when another device is actively editing it.
    void ensureEditLease({quiet:true});
    setStatus(unresolvedAssets.size || importedEpub?.sourceMissing?.length
      ? `“${draft.title}”을(를) 열었지만 ${unresolvedAssets.size ? `이미지 ${unresolvedAssets.size}개` : `원본 리소스 ${importedEpub.sourceMissing.length}개`}를 불러오지 못했습니다. 서버 원본은 변경되지 않았습니다.`
      : `“${draft.title}” 서버 저장본을 불러왔습니다.`, unresolvedAssets.size || importedEpub?.sourceMissing?.length ? 'error' : 'ok');
    return true;
  };
  const importEpub = async (file) => {
    const instanceId = bookProject.instanceId;
    const revision = bookProject.revision;
    const {files, packagePath, packageBase, originalIdentifier, metadataExtras,
      manifest, spineRefs, coverPagePaths, coverImage, chapterMeta, chapters,
      navItem, tocEntries, title, author, language} = await parseEpubFile(file, {
      unzipEpub, xmlDocument, zipText, zipPath, elementText,
      xhtmlBody, xhtmlTitle, tocEntriesFromNav, tocEntriesFromNcx,
      createChapterId, defaultChapterFileName,
    });
    if (bookProject.instanceId !== instanceId || bookProject.revision !== revision) throw new Error('불러오는 동안 현재 원고가 변경되었습니다. EPUB을 다시 선택하세요.');
    restoreEpoch++;
    void releaseEditLease();
    setProjectEditingAccess(true);
    importedEpub = null;
    footnotes.clear();
    replaceProjectChapters(chapters, chapters[0]?.id);
    $('#title').value = title;
    $('#author').value = author;
    $('#language').value = language;
    const stylesheet = Array.from(manifest.values()).find((item) => item.type === 'text/css' && files.has(item.href));
    hydrateCssValue(stylesheet ? zipText(files.get(stylesheet.href)) : '');
    Object.assign(bookProject, stylesFromCss($('#css').value));
    textStylesUi.render();
    bookProject.cssPresetId = null;
    renderCssPresetSelection();
    tocExcluded.clear();
    chapterMeta.forEach((meta) => { if (!meta.includeInToc) tocExcluded.add(meta.index); });
    parentTocMap.clear();
    collapsedTocRoots.clear();
    chapterMeta.forEach((meta) => {
      const parentIndex = chapterMeta.findIndex((candidate) => candidate.path === meta.tocParentPath);
      if (parentIndex >= 0) parentTocMap.set(meta.index, parentIndex);
    });
    clearPreviewAssets();
    renderAssetRecovery();
    // Keep every image declared by the OPF manifest, including unused images.
    // Its full ZIP path is the map key so case and directory names remain exact
    // for both preview resolution and a later source-preserving export.
    Array.from(manifest.values()).forEach((item) => {
      if (!item.type.startsWith('image/') || !files.has(item.href)) return;
      const blob = new Blob([files.get(item.href)], { type:item.type });
      const fileName = uniqueAssetName(item.href.split('/').pop() || 'image');
      previewAssets.set(fileName, {
        type:item.type,
        blob,
        url:URL.createObjectURL(blob),
        originalPath:item.href,
        isCover:item.href === coverImage?.href,
      });
    });
    const coverAsset = coverImage && previewAssetForPath(coverImage.href);
    if (coverAsset) { coverPreview.src = coverAsset.url; coverPreview.hidden = false; }
    else { coverPreview.removeAttribute('src'); coverPreview.hidden = true; }
    const footnoteItem = Array.from(manifest.values()).find((item) => item.type.includes('xhtml') && files.has(item.href) && (
      /<aside\b[^>]*\bepub:type\s*=\s*(["'])[^"']*\bfootnote\b/i.test(zipText(files.get(item.href))) ||
      /(?:^|\/)footnote\.xhtml$/i.test(item.href)
    ));
    importedEpub = {
      files, packagePath, packageBase, manifest:Array.from(manifest.values()), spineRefs, chapterMeta,
      tocTree:tocEntries.tree || [],
      navPath:navItem?.href || `${packageBase}nav.xhtml`, coverImagePath:coverImage?.href || '',
      coverPagePaths:Array.from(coverPagePaths), footnotePath:footnoteItem?.href || '', footnoteManifestId:footnoteItem?.id || '',
      stylesheetPath:stylesheet?.href || '', identifier:originalIdentifier, metadataExtras,
    };
    if (coverPagePaths.size || coverAsset) {
      const path = Array.from(coverPagePaths)[0];
      const source = path && files.has(path) ? zipText(files.get(path)) : '';
      const toc = tocEntries.get(path);
      addSpecialChapter('cover', { originalPath:path || '', xhtml:xhtmlBody(source), generated:!path,
        fileName:path?.split('/').pop() || 'cover.xhtml', title:toc?.title || '표지', includeInToc:Boolean(toc) });
      if (path) {
        const item = Array.from(manifest.values()).find(item => item.href === path);
        const ref = spineRefs.find(ref => ref.idref === item?.id);
        chapterMeta.push({ path, source, body:xhtmlBody(source), idref:item?.id, linear:ref?.linear || '',
          rawHref:item?.rawHref, tocTitle:toc?.title || '표지', tocLevel:1, includeInToc:Boolean(toc) });
      }
    }
    bookProject.chapters.forEach(chapter => { if (chapter.originalPath === footnoteItem?.href) chapter.type = 'footnotes'; });
    openedDraftTitle = null;
    setEditorActionIcon(draftButton,'Save','저장');
    chapterList.querySelector('.chapter[data-i="0"]')?.click();
    // 가져온 원문은 contenteditable의 HTML 재직렬화를 거치지 않도록 XHTML 모드에서 연다.
    htmlField.hidden = false;
    richToolbar.hidden = true;
    visualEditor.hidden = true;
    visualReadOnlyNotice.hidden = true;
    const modeToggle = mode.querySelector('[data-mode-toggle]');
    modeToggle.textContent = '일반편집';
    modeToggle.setAttribute('aria-pressed', 'true');
    syncOpenChapterEditor();
    renderAssetShelf();
    refreshChapterControls();
    refreshPreview();
    hydratePreviewAssets();
    bookProject.dirty = true; bookProject.revision++;
    setStatus(`“${title}” EPUB을 불러왔습니다. ${chapters.length}개 장을 편집할 수 있습니다.`);
  };
  importButton.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    await saveInFlight;
    if (!await confirmDiscardCurrent()) { importInput.value = ''; return; }
    try { await importEpub(file); }
    catch (error) { setStatus(error.message || 'EPUB 파일을 불러오지 못했습니다.', 'error'); }
    finally { importInput.value = ''; }
  });
  let projectOpenGeneration = 0;
  const openSavedProject = async (projectId) => {
    await saveInFlight;
    if (!await confirmDiscardCurrent()) return;
    const request = ++projectOpenGeneration;
    const epoch = restoreEpoch;
    const ownerId = persistenceOwnerId();
    try {
      if (request !== projectOpenGeneration || epoch !== restoreEpoch || ownerId !== persistenceOwnerId()) return;
      const draft = await readCloudProject(ownerId,projectId);
      if (request !== projectOpenGeneration || epoch !== restoreEpoch || ownerId !== persistenceOwnerId()) return;
      await loadDraft(draft,request);
    } catch (error) { setStatus(`프로젝트 열기 실패: ${error.message}`, 'error'); }
  };
  const deleteDialog = document.createElement('dialog');
  deleteDialog.className = 'gemini-settings-dialog draft-delete-dialog';
  deleteDialog.setAttribute('aria-label','프로젝트 삭제');
  deleteDialog.innerHTML = '<div class="gemini-dialog-head"><h2>프로젝트 삭제</h2></div><p class="delete-dialog-copy"></p><form method="dialog" class="gemini-dialog-footer"><button type="submit" value="cancel" class="secondary" data-close>취소</button><button type="submit" value="delete" class="primary">삭제</button></form>';
  document.body.append(deleteDialog);
  const confirmDeleteDraft = (draft, returnFocus) => new Promise(resolve => {
    deleteDialog.querySelector('.delete-dialog-copy').textContent = `“${draft.title}” 서버 저장본을 삭제할까요?`;
    deleteDialog.returnValue = '';
    deleteDialog.addEventListener('close', () => {
      if (returnFocus.isConnected) returnFocus.focus({preventScroll:true});
      resolve(deleteDialog.returnValue === 'delete');
    },{once:true});
    openModal(deleteDialog,deleteDialog.querySelector('[data-close]'));
  });
  const renderDrafts = () => {
    const drafts = getDrafts();
    draftsPanel.hidden = !draftsExpanded;
    draftsPanel.replaceChildren();
    if (!drafts.length) {
      const empty = document.createElement('p');
      empty.className = 'drafts-empty';
      empty.textContent = '서버 저장본 없음';
      draftsPanel.append(empty);
      return;
    }
    drafts.forEach((draft) => {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'draft-item';
      const name = document.createElement('span');
      name.textContent = draft.title;
      button.append(name);
      button.title = draft.title;
      button.setAttribute('aria-label', draft.title);
      if (draft.title === openedDraftTitle) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => { void openSavedProject(draft.projectId); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draft-delete';
      remove.title = '서버 저장본 삭제';
      remove.setAttribute('aria-label', `${draft.title} 삭제`);
      remove.append(lucideElement(Trash2,{width:15,height:15,'aria-hidden':'true'}));
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        await saveInFlight;
        if (bookProject.projectId === draft.projectId && !await confirmDiscardCurrent()) return;
        if (!await confirmDeleteDraft(draft,remove)) return;
        try {
          // Delete uses the row's stable project ID/revision, never the
          // currently open project's values. Do not invalidate the active
          // editor or its in-memory assets when a different sidebar row is
          // removed.
          const ownerId = persistenceOwnerId();
          await deleteCloudDraft(draft);
          deletedProjectIds.add(deletionKey(ownerId,draft.projectId));
          draftIndex = draftIndex.filter(item => item.projectId !== draft.projectId);
        } catch (error) {
          setStatus(`서버 저장본 삭제 실패: ${error.message || '서버 연결 실패'}`, 'error');
          void restoreCloudDrafts();
          return;
        }
        if (bookProject.projectId === draft.projectId) {
          bookProject.dirty = false;
          newBookButton.click();
        }
        renderDrafts();
        (draftsPanel.querySelector('.draft-item') || editorTab)?.focus({preventScroll:true});
        setStatus(`“${draft.title}” 서버 저장본을 삭제했습니다.`);
      });
      row.append(button, remove);
      draftsPanel.append(row);
    });
  };
  let cloudRestoreInFlight = null;
  let cloudRestoreQueued = false;
  const restoreCloudDrafts = () => {
    if (cloudRestoreInFlight) { cloudRestoreQueued = true; return cloudRestoreInFlight; }
    cloudRestoreInFlight = (async () => {
      if (!isAccessVerified() || !supabaseUser) return;
      const ownerId = supabaseUser.id;
      const epoch = restoreEpoch;
      const {rows,deletions} = await listCloudProjects(ownerId);
      if (epoch !== restoreEpoch || ownerId !== persistenceOwnerId()) return;
      deletedProjectIds.clear();
      deletions.forEach(row => deletedProjectIds.add(deletionKey(ownerId,row.project_id)));
      draftIndex = rows.filter(row => row.project_id && row.title).map(row => ({
        projectId:row.project_id,title:row.title,serverRevision:row.revision,lastServerSavedAt:row.updated_at,
      }));
      renderDrafts();
      if (deletedProjectIds.has(deletionKey(ownerId,bookProject.projectId)))
        setStatus('현재 원고가 서버에서 삭제되었습니다. 탭의 변경 사항을 내보내세요.', 'error');
    })().catch(error => {
      setStatus(`서버 프로젝트 목록을 불러오지 못했습니다: ${error.message}`,'error');
    }).finally(() => {
      cloudRestoreInFlight = null;
      if (cloudRestoreQueued) { cloudRestoreQueued = false; void restoreCloudDrafts(); }
    });
    return cloudRestoreInFlight;
  };
  const performSaveCurrentDraft = async () => {
    const epoch = restoreEpoch;
    const ownerId = persistenceOwnerId();
    const instanceId = bookProject.instanceId;
    const draft = collectDraft();
    const savedRevision = bookProject.revision;
    const current = () => epoch === restoreEpoch && ownerId === persistenceOwnerId() && instanceId === bookProject.instanceId;
    try {
      if (!draft.title) throw new Error('책 제목을 입력하세요.');
      if (unresolvedAssets.size) throw new Error(`이미지 ${unresolvedAssets.size}개를 불러오지 못했습니다. 서버 원본을 확인하세요.`);
      if (deletedProjectIds.has(deletionKey(ownerId,draft.projectId))) throw new Error('서버에서 삭제된 원고입니다. 현재 내용을 내보내세요.');
      const footnoteResult = prepareFootnotes(draft);
      if (footnoteResult.errors.length) throw new Error(`각주 오류 ${footnoteResult.errors.length}건이 있습니다.`);
      draft.footnotes = footnoteResult.notes.map(note => ({...note}));
      draft.chapters.forEach(chapter => { chapter.xhtml = chapter.body; });
      const htmlErrors = validateAllChapters(draft);
      if (htmlErrors.length) {
        const error = htmlErrors[0];
        throw new Error(`${error.title}: ${error.line}행 ${error.column}열 — ${error.message}`);
      }
      const assets = Array.from(previewAssets,([name,asset]) => [name,{...asset}]);
      for (const [name,asset] of assets) {
        asset.hash ||= await assetHash(asset.blob);
        if (previewAssets.get(name)?.blob === asset.blob) previewAssets.get(name).hash = asset.hash;
        const entry = draft.assets.find(item => item.name === name);
        if (entry) entry.hash = asset.hash;
      }
      const sourceAssets = sourceAssetEntries(draft);
      for (const [name,asset] of sourceAssets) {
        if (!asset.blob) throw new Error(`원본 EPUB 리소스 “${asset.originalPath}”을(를) 찾지 못했습니다.`);
        asset.hash ||= await assetHash(asset.blob);
        const entry = draft.importedSource?.resources?.find(item => (item.name || sourceAssetName(item.path)) === name);
        if (entry) { entry.name = name; entry.hash = asset.hash; entry.storagePath ||= asset.storagePath; }
      }
      if (!current()) return false;
      if (!await ensureEditLease({quiet:true})) throw new Error('편집 권한을 확인할 수 없습니다. 현재 탭의 원고는 유지됩니다.');
      if (!current()) return false;
      await saveCloudDraft(draft,new Map([...assets,...sourceAssets]),ownerId);
      if (!current()) return true;
      bookProject.serverRevision = draft.serverRevision;
      openedDraftTitle = draft.title;
      draftIndex = draftIndex.filter(item => item.projectId !== draft.projectId);
      draftIndex.unshift({projectId:draft.projectId,title:draft.title,serverRevision:draft.serverRevision,lastServerSavedAt:draft.lastServerSavedAt});
      bookProject.dirty = savedRevision !== bookProject.revision;
      renderDrafts();
      setStatus(bookProject.dirty ? '저장 요청 당시 수정본은 서버에 저장됐습니다. 이후 변경은 미저장 상태입니다.' : '서버 저장 완료.','ok');
      return true;
    } catch (error) {
      if (current()) setStatus(`서버 저장 실패: ${error.message}`,'error');
      return false;
    }
  };
  function showLeaseNotice(message) {
    const key = `${bookProject.projectId}:lease:${editLease?.generation || 'lost'}`;
    if (leaseNoticeKeys.has(key)) return;
    leaseNoticeKeys.add(key);
    setStatus(message,'error');
  }
  const leaseTransferDialog = document.createElement('dialog');
  leaseTransferDialog.className = 'gemini-settings-dialog draft-delete-dialog';
  leaseTransferDialog.setAttribute('aria-label','편집 권한 가져오기');
  leaseTransferDialog.innerHTML = '<div class="gemini-dialog-head"><h2>여기서 편집할까요?</h2></div><p class="delete-dialog-copy">다른 기기의 편집 권한이 이 탭으로 이전됩니다. 그 기기의 미저장 내용은 열린 탭에서만 유지됩니다.</p><form method="dialog" class="gemini-dialog-footer"><button type="submit" value="cancel" class="secondary" data-close>취소</button><button type="submit" value="take" class="primary">여기서 편집</button></form>';
  document.body.append(leaseTransferDialog);
  takeEditButton.addEventListener('click', () => {
    leaseTransferDialog.returnValue = '';
    leaseTransferDialog.addEventListener('close', async () => {
      if (leaseTransferDialog.returnValue !== 'take') return;
      const granted = await ensureEditLease({takeover:true});
      if (!granted) return;
      setStatus('이 탭으로 편집 권한을 가져왔습니다.');
      await restoreCloudDrafts();
    },{once:true});
    openModal(leaseTransferDialog,leaseTransferDialog.querySelector('[data-close]'));
  });
  let saveInFlight = null;
  let saveQueued = false;
  const saveCurrentDraft = () => {
    saveQueued = true;
    if (saveInFlight) return saveInFlight;
    draftButton.disabled = true;
    setEditorActionIcon(draftButton,'LoaderCircle','저장 중...');
    saveInFlight = (async () => {
      let result = true;
      while (saveQueued) {
        saveQueued = false;
        result = await performSaveCurrentDraft();
      }
      return result;
    })().catch(error => { setStatus(`서버 저장 실패: ${error.message}`,'error'); return false; })
      .finally(() => {
        saveInFlight = null;
        draftButton.disabled = !hasCurrentEditLease() && Boolean(openedDraftTitle);
        setEditorActionIcon(draftButton,'Save','저장');
      });
    return saveInFlight;
  };
  draftButton.addEventListener('click', () => { void saveCurrentDraft(); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!event.repeat) void saveCurrentDraft({ shortcut:true });
    }
  });
  renderDrafts();

  const {refreshPreview, schedulePreview, synchronizeFocus, sourceNodeForElement,
    previewBlockSelector, previewTextOffset, sourceTextOffset, isFocusSyncing} = mountPreviewSync({
    previewUi, preview, htmlEditor, cssEditor, visualEditor, bookProject,
    isCoverSelected, showCoverPreview, snapshotCurrentChapter, hydrateResourceImages, activeChapterIndex,
    getVisualLoadedChapterId:() => visualLoadedChapterId,
    getTiptapEditor:() => tiptapEditor,
    followBookLink:(anchor) => followBookLink(anchor),
  });
  const syncFromVisual = () => {
    if (!tiptapEditor || !tiptapEditor.isEditable || tiptapEditor.view.composing || suppressTiptapUpdate || visualEditor.hidden || visualLoadedChapterId !== bookProject.selectedChapterId) return;
    if (getVisualHtml() === visualBaseline) return;
    // Only Tiptap transactions may write general-editor content back to XHTML.
    let source;
    try { source = serializeVisualXhtml(getVisualHtml()); }
    catch (error) { setStatus(`${error.message} 원본 원고를 유지했습니다.`, 'error'); return; }
    htmlEditor.value = source;
    visualBaseline = getVisualHtml();
    // Tiptap history is disabled so both modes share the chapter's Monaco
    // model. Delimit each visual transaction before the textarea bridge runs.
    window.recordChapterEdit?.(bookProject.selectedChapter, source, true);
    htmlEditor.dispatchEvent(new Event('input', { bubbles: true }));
  };
  function saveCurrentChapter() {
    if (!bookProject.selectedChapter) return;
    // 표지 읽기 전용 화면에는 본문 editor buffer가 없다. 이전 장 내용을 다시
    // 저장해 덮어쓰지 않도록 아무 chapter도 변경하지 않는다.
    if (isCoverSelected() && htmlField.hidden) return;
    chapterFileNames.set(activeChapterIndex(), sigilFileName.value.trim());
    if (collectingDraft) return;
    if (!visualEditor.hidden) {
      syncFromVisual();
    } else {
      const monacoEditor = window.epubMonacoEditor;
      if (monacoEditor && monacoEditor.getValue() !== htmlEditor.value) htmlEditor.value = monacoEditor.getValue();
      // 기존 앱의 input 저장 핸들러를 통해 현재 장의 title·목차·본문 state를 함께 갱신한다.
      htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
    }
    snapshotCurrentChapter();
  }
  const followBookLink = (anchor) => {
    const href = anchor?.getAttribute('href');
    if (!href || /^(?:https?:|mailto:|data:)/i.test(href) || !bookProject.selectedChapter) return false;
    const from = chapterPath(bookProject.selectedChapter);
    const url = new URL(href, 'https://epub.local/' + from);
    const path = decodeURIComponent(url.pathname.slice(1));
    let target = bookProject.chapters.find(chapter => chapterPath(chapter) === path);
    if (!target && importedEpub?.files.has(path)) {
      target = addSpecialChapter('footnotes', { originalPath:path, fileName:path.split('/').pop(), xhtml:xhtmlBody(zipText(importedEpub.files.get(path))), generated:false });
    }
    if (!target) return false;
    const row = chapterList.querySelector(`[data-chapter-id="${target.id}"]`);
    selectManagedChapter(Number(row.dataset.i));
    const id = decodeURIComponent(url.hash.slice(1));
    const node = sourceElements(htmlEditor.value).find(item => sourceAttribute(item, 'id') === id);
    if (node) synchronizeFocus(node, 'link');
    return true;
  };
  const xhtmlVoidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const normaliseXhtml = (source) => {
    // XML parser가 읽을 수 있도록 XHTML 빈 요소와 오타 난 여는 괄호를 먼저 보정합니다.
    const prepared = String(source || '')
      .replace(/<\s+([A-Za-z][\w:-]*)/g, '<$1')
      .replace(/<\s*(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)>/gi, (_, tag, attrs) => `<${tag.toLowerCase()}${attrs.replace(/\s*\/\s*$/, '').trim() ? ` ${attrs.replace(/\s*\/\s*$/, '').trim()}` : ''} />`);
    const parser = new DOMParser();
    const documentSource = `<epub-fragment xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">${prepared}</epub-fragment>`;
    const parsed = parser.parseFromString(documentSource, 'application/xhtml+xml');
    if (parsed.querySelector('parsererror')) return prepared;
    const serialised = new XMLSerializer().serializeToString(parsed.documentElement);
    const fragment = serialised
      .replace(/^<epub-fragment[^>]*>/, '')
      .replace(/<\/epub-fragment>$/, '')
      .replace(/\s*\/\s*>/g, ' />');
    // XMLSerializer는 빈 일반 요소도 <li />처럼 축약한다. EPUB 원고에서는
    // 명시적인 닫는 태그를 유지해 자동 완성·가독성·검증 결과를 일관되게 한다.
    return fragment.replace(/<([A-Za-z][\w:-]*)([^>]*)\s\/>/g, (whole, tag, attributes) => (
      xhtmlVoidTags.has(tag.toLowerCase()) ? whole : `<${tag}${attributes}></${tag}>`
    ));
  };
  const updateLineNumbers = () => {
    const style = getComputedStyle(htmlEditor);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const contentWidth = Math.max(1, htmlEditor.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const rows = htmlEditor.value.split('\n').flatMap((line, index) => {
      const visualRows = Math.max(1, Math.ceil(context.measureText(line || ' ').width / contentWidth));
      return [String(index + 1), ...Array(visualRows - 1).fill('')];
    });
    lineNumbers.textContent = (rows.length ? rows : ['1']).join('\n');
    lineNumbers.style.transform = `translateY(-${htmlEditor.scrollTop}px)`;
  };
  const findHtmlErrors = source => validateXhtml(source);
  const findHtmlError = (source) => findHtmlErrors(source)[0] || null;
  const closeChapterErrorPopover = () => {
    chapterErrorPopover.hidden = true;
    chapterErrorAlert.setAttribute('aria-expanded', 'false');
  };
  const renderChapterErrorPopover = () => {
    chapterErrorPopover.replaceChildren();
    const header = document.createElement('div');
    header.className = 'chapter-error-popover__head';
    const title = document.createElement('span');
    title.textContent = `현재 장 오류 ${currentChapterErrors.length}개`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chapter-error-popover__close';
    close.setAttribute('aria-label', '오류 상세 닫기');
    close.textContent = '×';
    close.addEventListener('click', closeChapterErrorPopover);
    header.append(title, close);
    const list = document.createElement('ol');
    list.className = 'chapter-error-popover__list';
    currentChapterErrors.forEach((error) => {
      const item = document.createElement('li');
      item.textContent = `${error.line}행 ${error.column || 1}열: ${error.message}`;
      list.append(item);
    });
    chapterErrorPopover.append(header, list);
  };
  const updateChapterErrorAlert = (errors) => {
    currentChapterErrors = errors;
    const count = errors.length;
    chapterErrorAlert.hidden = count === 0;
    chapterErrorAlert.textContent = `오류 ${count}`;
    chapterErrorAlert.title = `현재 장의 XHTML 오류 ${count}개 보기`;
    if (!count) closeChapterErrorPopover();
    else if (!chapterErrorPopover.hidden) renderChapterErrorPopover();
  };
  chapterErrorAlert.addEventListener('click', (event) => {
    event.stopPropagation();
    if (chapterErrorPopover.hidden) {
      renderChapterErrorPopover();
      chapterErrorPopover.hidden = false;
      const bounds = chapterErrorAlert.getBoundingClientRect();
      chapterErrorPopover.style.top = `${Math.min(window.innerHeight - chapterErrorPopover.offsetHeight - 14, bounds.bottom + 8)}px`;
      chapterErrorPopover.style.left = `${Math.max(14, Math.min(window.innerWidth - chapterErrorPopover.offsetWidth - 14, bounds.left))}px`;
      chapterErrorAlert.setAttribute('aria-expanded', 'true');
    } else closeChapterErrorPopover();
  });
  document.addEventListener('click', (event) => {
    if (!chapterErrorPopover.hidden && !chapterErrorPopover.contains(event.target) && event.target !== chapterErrorAlert) closeChapterErrorPopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !chapterErrorPopover.hidden) { closeChapterErrorPopover(); chapterErrorAlert.focus({preventScroll:true}); }
  });
  const validateHtml = () => {
    const errors = findHtmlErrors(htmlEditor.value);
    // 긴 상세 문구는 작업 화면에 직접 노출하지 않고, 고정 폭 알림 버튼의 팝오버에서만 보여준다.
    xhtmlDiagnostics.hidden = true;
    updateChapterErrorAlert(errors);
  };
  const validateAllChapters = (draft = collectDraft()) => draft.chapters.flatMap((chapter, index) =>
    findHtmlErrors(chapter.body).map((error) => ({ chapter:index + 1, title:chapter.title || '제목 없는 장', ...error }))
  );
  const countXhtmlFixes = (before, after) => {
    if (before === after) return 0;
    const voidFixes = Array.from(before.matchAll(/<\s*(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b[^>]*?(?<!\/)\s*>/gi)).length;
    const malformedOpenings = Array.from(before.matchAll(/<\s+[A-Za-z][\w:-]*/g)).length;
    return Math.max(1, voidFixes + malformedOpenings);
  };
  // 응답 JSON까지 포함해 모델 출력 한도 안에 머물도록 문단 묶음 크기를 제한한다.
  // 각 문단 자체는 나누지 않아 자연스러운 문맥을 유지한다.
  const GEMINI_MAX_CHUNK_CHARACTERS = 6000;
  // 교정 요청은 현재 장 하나에 대해 한 번만 실행한다. 완료·실패 여부와 관계없이
  // finally에서 해제해 다음 교정 요청을 막지 않는다.
  let geminiRequest = null;
  const finishProofread = request => {
    request.apiKey = '';
    if (geminiRequest !== request) return;
    geminiRequest = null;
    proofreadButton.disabled = false; setEditorActionIcon(proofreadButton,'SpellCheck','맞춤법 교정');
  };
  bookProject.onInvalidate = chapter => {
    if (geminiRequest && (!chapter || geminiRequest.chapter === chapter)) {
      const request = geminiRequest; request.controller.abort(); finishProofread(request);
      setStatus(`${request.title}: 대상 장 또는 프로젝트가 변경되어 교정을 취소했습니다.`);
    }
  };
  window.addEventListener('sitescout-identity-invalidated', () => {
    sessionGeminiKey = ''; geminiApiKeyField.value = ''; geminiPromptField.value = '';
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    if (geminiRequest) { geminiRequest.controller.abort(); finishProofread(geminiRequest); }
    try { localStorage.removeItem(GEMINI_API_KEY_STORAGE); } catch { /* No key is read. */ }
  });
  const applyGeminiSuggestions = (items, targetChapter, source) => {
    if (!bookProject.chapters.includes(targetChapter) || targetChapter.xhtml !== source) return false;
    if (!items.length) { setStatus('수정할 항목이 없습니다.'); return true; }
    try {
      const before = source;
      const edits = items.map(({ start, end, original, replacement }) => ({ start, end, original, replacement }));
      const after = applySourceEdits(before, edits);
      if (validateXhtml(after).length) throw new Error('교정 결과 XHTML 검증 실패: 원문을 유지했습니다.');
      if (bookProject.selectedChapter !== targetChapter) {
        window.recordChapterEdit?.(targetChapter,after,true);
        bookProject.update(targetChapter.id,{xhtml:after});
        setStatus(`${targetChapter.title}: ${items.length}건의 교정을 적용했습니다.`);
        return true;
      }
      const monacoEditor = window.epubMonacoEditor;
      monacoEditor?.getModel()?.pushStackElement();
      if (!visualEditor.hidden) {
        // 일반편집은 Tiptap 한 곳에만 반영한다. Monaco까지 동시에 갱신하면 재저장 때 본문이 중복될 수 있다.
        htmlEditor.value = after;
        setVisualHtml(after);
        htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
      } else if (monacoEditor && monacoEditor.getValue() === before && window.monaco) {
        const model = monacoEditor.getModel();
        monacoEditor.executeEdits('gemini-proofread', edits.sort((a, b) => b.start - a.start).map((edit) => {
          const from = model.getPositionAt(edit.start); const to = model.getPositionAt(edit.end);
          return { range:new window.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text:edit.replacement };
        }));
      } else { htmlEditor.value = after; htmlEditor.dispatchEvent(new Event('input', { bubbles:true })); }
      if (htmlEditor.value !== after) { htmlEditor.value = after; htmlEditor.dispatchEvent(new Event('input', { bubbles:true })); }
      snapshotCurrentChapter();
      refreshPreview();
      monacoEditor?.getModel()?.pushStackElement();
      updateToolbarState();
      setStatus(`${targetChapter.title}: ${items.length}건의 교정을 적용했습니다.`); return true;
    } catch (error) { setStatus(error.message || '교정을 적용하지 못했습니다. 다시 검사하세요.', 'error'); return false; }
  };
  proofreadButton.addEventListener('click', async () => {
    if (geminiRequest) return;
    const settings = readGeminiSettings();
    if (!settings.apiKey) {
      setStatus('Gemini API 설정이 필요합니다.', 'error');
      openModal(geminiApiRequiredDialog, geminiApiRequiredDialog.querySelector('[data-open-settings]'));
      return;
    }
    saveCurrentChapter();
    const targetChapter = bookProject.selectedChapter;
    const source = htmlEditor.value;
    const paragraphs = extractProofreadParagraphs(source);
    if (!paragraphs.length) { setStatus('현재 장에서 검사할 본문 텍스트가 없습니다.', 'error'); return; }
    const request = {id:crypto.randomUUID(),ownerId:persistenceOwnerId(),projectId:bookProject.projectId,instanceId:bookProject.instanceId,
      chapter:targetChapter,sourceRevision:targetChapter.sourceRevision || 0,source,title:targetChapter.title,controller:new AbortController(),apiKey:settings.apiKey};
    settings.apiKey = '';
    geminiRequest = request; proofreadButton.disabled = true; setEditorActionIcon(proofreadButton,'LoaderCircle','교정 중...');
    setStatus(`${request.title}: 교정 중…`);
    const validTarget = () => geminiRequest === request && !request.controller.signal.aborted && request.ownerId === persistenceOwnerId()
      && request.projectId === bookProject.projectId && request.instanceId === bookProject.instanceId && bookProject.chapters.includes(targetChapter);
    try {
      const chunks = chunkProofreadParagraphs(paragraphs, GEMINI_MAX_CHUNK_CHARACTERS);
      const paragraphById = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
      const raw = [];
      for (const chunk of chunks) {
        if (!validTarget()) return;
        raw.push(...await requestGeminiCorrections({
        apiKey:request.apiKey, signal:request.controller.signal,
        systemInstruction:settings.prompt,
        paragraphs:chunk,
      }));
      }
      if (!validTarget()) return;
      const seen = new Set(); const accepted = [];
      raw.forEach((result) => {
        const paragraph = paragraphById.get(result?.id);
        const correctedText = String(result?.correctedText ?? '');
        if (!paragraph || correctedText === paragraph.text || isSuspiciousCorrection(paragraph.text, correctedText)) return;
        diffPartsToSourceEdits(diffChars(paragraph.text, correctedText), paragraph, source).forEach((edit) => {
          const key = `${edit.start}:${edit.end}:${edit.replacement}`;
          if (seen.has(key) || accepted.some((item) => edit.start < item.end && edit.end > item.start)) return;
          seen.add(key); accepted.push({ ...edit, type:'교정' });
        });
      });
      if (targetChapter.xhtml !== source || (targetChapter.sourceRevision || 0) !== request.sourceRevision) {
        setStatus(`${request.title}: 원문이 변경되어 교정 결과를 적용하지 않았습니다.`,'error');
        return;
      }
      applyGeminiSuggestions(accepted, targetChapter, source);
    } catch (error) { if (validTarget()) setStatus(`${request.title}: ${error.message || '교정 실패'}`, 'error'); }
    finally { finishProofread(request); }
  });
  autoFixHtmlButton.addEventListener('click', () => {
    saveCurrentChapter();
    let chapters = 0; let changes = 0; const errors = [];
    for (const chapter of bookProject.chapters) {
      const before = chapter.xhtml;
      const after = fixXhtmlVoidElements(before);
      const invalid = validateXhtml(after);
      if (invalid.length) { errors.push(`${chapter.title}: ${invalid[0].line}행 ${invalid[0].column}열 ${invalid[0].message}`); continue; }
      if (after === before) continue;
      chapters++;
      changes += diffChars(before, after).filter(part => part.added).length;
      window.recordChapterEdit?.(chapter, after, true);
      bookProject.update(chapter.id, { xhtml:after });
    }
    if (bookProject.selectedChapter) setCurrentChapter(bookProject.selectedChapter);
    refreshPreview();
    setStatus(`총 ${chapters}개 장 / ${changes}개 항목 수정${errors.length ? ` · 수정할 수 없는 오류: ${errors.join(' / ')}` : ''}`, errors.length ? 'error' : 'ok');
  });
  const setMode = (nextMode) => {
    const visual = nextMode === 'visual';
    saveCurrentChapter();
    if (visual) setVisualHtml(htmlEditor.value);
    else {
      syncFromVisual();
      // 일반편집에서 XHTML로 돌아갈 때 전체 formatter를 적용하면 canonical
      // source가 바뀌고 이전 editor cache가 덮어쓸 수 있다. 현재 chapter의
      // 동기화된 XHTML을 그대로 Monaco에 보여 준다.
      const monacoEditor = window.epubMonacoEditor;
      if (monacoEditor) window.loadXhtmlMonaco?.(htmlEditor.value);
    }
    htmlField.hidden = visual;
    richToolbar.hidden = !visual;
    visualEditor.hidden = !visual;
    visualReadOnlyNotice.hidden = !visual || !tiptapEditor || tiptapEditor.isEditable;
    const toggle = mode.querySelector('[data-mode-toggle]');
    toggle.textContent = visual ? 'XHTML편집' : '일반편집';
    toggle.setAttribute('aria-pressed', String(!visual));
    if (isCoverSelected()) openCoverReadOnly();
    if (!visual) void window.formatXhtmlMonacoForDisplay?.();
  };
  htmlEditor.addEventListener('input', () => {
    updateLineNumbers();
    validateHtml();
    updateChapterCharacterCount();
    schedulePreview();
  });
  htmlEditor.addEventListener('scroll', updateLineNumbers);
  new ResizeObserver(updateLineNumbers).observe(htmlEditor);
  const statusBox = $('#status');
  const decorateStatus = () => {
    if (!statusBox.classList.contains('ok') && !statusBox.classList.contains('error')) return;
    if (statusBox.querySelector('.status-close')) return;
    let message = statusBox.textContent.trim();
    if (message === 'EPUB 3.0 파일을 만들었습니다. 다운로드 폴더를 확인하세요.') {
      const title = $('#title').value.trim() || '새 전자책';
      message = `[${title}] EPUB 3.0 파일을 다운로드했습니다. 다운로드 폴더를 확인하세요.`;
    }
    statusBox.replaceChildren(document.createTextNode(message));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'status-close';
    close.setAttribute('aria-label', '알림 닫기');
    close.textContent = '×';
    close.addEventListener('click', () => {
      clearStatusTimers();
      statusBox.textContent = '';
      statusBox.className = 'status';
    });
    statusBox.append(close);
    scheduleStatusDismissal();
  };
  new MutationObserver(decorateStatus).observe(statusBox, { childList:true, characterData:true, attributes:true });
  mode.addEventListener('click', (event) => {
    if (!event.target.closest('[data-mode-toggle]')) return;
    editorTools?.close(); setMode(htmlField.hidden ? 'html' : 'visual');
  });
  let activeBlock = null;
  const editableBlock = (node) => node?.closest?.('p,h1,h2,h3,h4,h5,li,blockquote,td,th');
  const orderedListSelection = () => {
    if (!tiptapEditor) return null;
    const list = activeBlock?.closest?.('ol');
    if (list && visualEditor.contains(list)) {
      try {
        const $pos = tiptapEditor.state.doc.resolve(tiptapEditor.view.posAtDOM(list, 0));
        for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === 'orderedList') return { $from:$pos, depth };
      } catch { /* use the current ProseMirror selection below */ }
    }
    const {$from} = tiptapEditor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'orderedList') return { $from, depth };
    return null;
  };
  visualEditor.addEventListener('click', (event) => {
    activeBlock = editableBlock(event.target);
  });
  const historyButtons = [...richToolbar.querySelectorAll('[data-editor-action]')];
  const updateToolbarState = () => {
    const model = window.epubMonacoEditor?.getModel();
    for (const button of historyButtons) button.disabled = document.documentElement.dataset.projectEditAccess === 'readonly'
      || !bookProject.selectedChapter || !(button.dataset.editorAction === 'undo' ? model?.canUndo() : model?.canRedo());
    if (tiptapEditor) {
      const editor = tiptapEditor;
      const active = (name, attrs) => editor.isActive(name, attrs);
      [['bold','bold'], ['italic','italic'], ['superscript','superscript'], ['subscript','subscript']].forEach(([command, selector]) => {
        richToolbar.querySelector(`[data-command="${selector}"]`)?.classList.toggle('active', active(command));
      });
      const alignment = editor.getAttributes('paragraph').textAlign || editor.getAttributes('heading').textAlign || 'left';
      [['justifyLeft','left'], ['justifyCenter','center'], ['justifyRight','right'], ['justifyFull','justify']].forEach(([selector, value]) => {
        richToolbar.querySelector(`[data-command="${selector}"]`)?.classList.toggle('active', alignment === value);
      });
      const heading = [1,2,3,4,5].find(level => active('heading',{level}));
      richToolbar.querySelector('[data-heading]').value = heading ? `h${heading}` : '';
      let listNode = null;
      const {$from} = editor.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === 'orderedList' || node.type.name === 'bulletList') { listNode = node; break; }
      }
      richToolbar.querySelector('[data-list]').value = listNode
        ? (listNode.type.name === 'bulletList' ? 'disc' : (listNode.attrs.style?.match(/list-style-type\s*:\s*([^;]+)/i)?.[1] || 'decimal')) : '';
      const textStyle = editor.getAttributes('textStyle');
      richToolbar.querySelector('[data-font-size]').value = textStyle.fontSize?.replace('px','') || '';
      richToolbar.querySelector('[data-font-family]').value = textStyle.fontFamily || '';
      return;
    }
    const selection = window.getSelection();
    const node = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection?.anchorNode?.parentElement;
    if (!node || !visualEditor.contains(node)) return;
    [['bold', 'bold'], ['italic', 'italic'], ['superscript', 'superscript'], ['subscript', 'subscript'], ['justifyLeft', 'justifyLeft'], ['justifyCenter', 'justifyCenter'], ['justifyRight', 'justifyRight'], ['justifyFull', 'justifyFull']].forEach(([command, selector]) => {
      richToolbar.querySelector(`[data-command="${selector}"]`)?.classList.toggle('active', document.queryCommandState(command));
    });
    const heading = node.closest('h1,h2,h3,h4,h5');
    activeBlock = editableBlock(node);
    richToolbar.querySelector('[data-heading]').value = heading?.tagName.toLowerCase() || '';
    const list = node.closest('ol,ul');
    richToolbar.querySelector('[data-list]').value = list ? (list.tagName === 'UL' ? 'disc' : (list.style.listStyleType || 'decimal')) : '';
    const sized = node.closest('span[style*="font-size"]');
    richToolbar.querySelector('[data-font-size]').value = sized?.style.fontSize?.replace('px', '') || '';
    richToolbar.querySelector('[data-font-family]').value = activeBlock?.style.fontFamily || '';
  };
  // 커서 이동 때만 preview-ui의 source↔iframe 위치 매핑을 사용한다.
  // 원고 렌더링 자체는 사용자의 미리보기 스크롤 위치를 유지한다.
  visualEditor.addEventListener('compositionend', () => { queueMicrotask(() => syncFromVisual()); });
  visualEditor.addEventListener('input', () => { syncFromVisual({ normalise:false }); updateToolbarState(); });
  visualEditor.addEventListener('keyup', () => { rememberVisualRange(); updateToolbarState(); });
  visualEditor.addEventListener('mouseup', () => { rememberVisualRange(); updateToolbarState(); });
  // Toolbar buttons must not steal the ProseMirror DOM selection before their
  // command runs. Selects and text inputs remain focusable controls.
  richToolbar.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  richToolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button === footnoteButton) return;
    if (tiptapEditor) {
      const chain = tiptapEditor.chain().focus();
      if (button.dataset.list) {
        if (button.dataset.list === 'disc') chain.toggleBulletList().run();
        else {
          const requested = button.dataset.list;
          tiptapEditor.commands.focus();
          const ordered = orderedListSelection();
          if (ordered) {
            const node = ordered.$from.node(ordered.depth);
            const style = requested === 'decimal' ? null : `list-style-type: ${requested}`;
            tiptapEditor.view.dispatch(tiptapEditor.state.tr.setNodeMarkup(ordered.$from.before(ordered.depth), undefined, { ...node.attrs, style }));
          } else chain.toggleOrderedList().run();
        }
      } else if (button.dataset.block || button.dataset.value === 'blockquote') {
        chain.toggleBlockquote().run();
      } else {
        const actions = {
          bold:'toggleBold', italic:'toggleItalic', superscript:'toggleSuperscript',
          subscript:'toggleSubscript', justifyLeft:'setTextAlign', justifyCenter:'setTextAlign',
          justifyRight:'setTextAlign', justifyFull:'setTextAlign',
        };
        const action = actions[button.dataset.command];
        if (!action) return;
        if (action === 'setTextAlign') {
          const alignments = { justifyLeft:'left', justifyCenter:'center', justifyRight:'right', justifyFull:'justify' };
          chain.setTextAlign(alignments[button.dataset.command]).run();
        } else chain[action]().run();
      }
      syncFromVisual();
      updateToolbarState();
      return;
    }
    restoreVisualRange() || visualEditor.focus();
    if (button.dataset.list) {
      document.execCommand('insertOrderedList', false, null);
      const selection = window.getSelection();
      const node = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection?.anchorNode?.parentElement;
      node?.closest('ol')?.style.setProperty('list-style-type', button.dataset.list);
    } else if (button.dataset.block) document.execCommand('formatBlock', false, button.dataset.block);
    else document.execCommand(button.dataset.command, false, button.dataset.value || null);
    syncFromVisual();
    rememberVisualRange();
  });
  richToolbar.querySelector('[data-heading]').addEventListener('change', (event) => {
    if (event.target.value === 'add-style') { textStylesUi.open(true); event.target.value = ''; return; }
    if (event.target.value.startsWith('custom:')) {
      const style = bookProject.customStyles.find(item => `custom:${item.id}` === event.target.value);
      if (!tiptapEditor || !style) return;
      if (!(style.kind === 'tag' ? applyTagStyle(tiptapEditor, style.tag) : applyCustomStyle(tiptapEditor, style))) setStatus('스타일을 적용할 텍스트 또는 블록을 선택하세요.', 'error');
      syncFromVisual();
      return;
    }
    if (tiptapEditor) {
      const level = Number(String(event.target.value).replace('h', ''));
      const chain = tiptapEditor.chain().focus();
      if (level) chain.setHeading({ level }).run();
      else chain.setParagraph().run();
      syncFromVisual();
      return;
    }
    visualEditor.focus();
    document.execCommand('formatBlock', false, event.target.value || 'p');
    syncFromVisual();
  });
  const fontSizeInput = richToolbar.querySelector('[data-font-size]');
  let fontSizeApplyTimer = null;
  let fontSizeValueBeforeFocus = '';
  let fontSizeValueTouched = false;
  fontSizeInput.addEventListener('focus', (event) => {
    fontSizeValueBeforeFocus = event.target.value;
    fontSizeValueTouched = false;
    // datalist는 현재 input 값을 검색어로 사용한다. 기존 14px 값을 비워 전체
    // 크기 목록을 다시 열어, 다른 값도 클릭만으로 바꿀 수 있게 한다.
    event.target.value = '';
  });
  fontSizeInput.addEventListener('input', (event) => {
    // datalist에서 항목을 고른 경우에는 blur 없이도 바로 반영한다. 직접 여러
    // 자릿수를 입력할 때는 잠깐 기다려 값이 완성된 뒤 한 번만 적용한다.
    fontSizeValueTouched = true;
    window.clearTimeout(fontSizeApplyTimer);
    fontSizeApplyTimer = window.setTimeout(() => {
      event.target.dispatchEvent(new Event('change', { bubbles:true }));
    }, 280);
  });
  fontSizeInput.addEventListener('change', (event) => {
    window.clearTimeout(fontSizeApplyTimer);
    const input = event.target;
    // 목록을 열어 보기만 하고 닫은 경우에는 기존 크기를 유지한다. 빈 값으로
    // 변경하려는 의도가 아니므로 font-size 제거로 해석하지 않는다.
    if (!fontSizeValueTouched && !input.value) {
      input.value = fontSizeValueBeforeFocus;
      return;
    }
    // 툴바 input을 클릭하면 편집기의 브라우저 선택 영역이 사라질 수 있다.
    // 마지막 선택 범위를 복원해, 텍스트 선택 시에는 단락이 아닌 그 범위만 바꾼다.
    // 폰트 크기 input이 포커스를 가진 상태에서도, 드래그해 둔 범위를 직접
    // 수정한다. focus()로 에디터를 다시 활성화하면 선택이 사라질 수 있다.
    const range = storedVisualRange();
    const hasTextSelection = Boolean(range && !range.collapsed);
    if (!input.value) {
      if (tiptapEditor) {
        // font-family 등 같은 span의 다른 속성은 보존하고 크기만 제거한다.
        tiptapEditor.chain().focus().setMark('textStyle', { fontSize:null }).run();
        syncFromVisual();
        return;
      }
      if (hasTextSelection) {
        // 기존 선택 범위에 만들어진 font-size span만 제거한다. removeFormat은 굵게,
        // 링크 등 다른 서식까지 지우므로 사용하지 않는다.
        const selectedSpans = Array.from(visualEditor.querySelectorAll('span[style*="font-size"]')).filter((span) => range.intersectsNode(span));
        selectedSpans.forEach((span) => {
          span.style.removeProperty('font-size');
          if (!span.getAttribute('style')?.trim()) span.replaceWith(...span.childNodes);
        });
      } else if (activeBlock) activeBlock.style.removeProperty('font-size');
      else window.getSelection()?.anchorNode?.parentElement?.closest('span[style*="font-size"]')?.style.removeProperty('font-size');
      syncFromVisual();
      return;
    }
    const size = /^\d+(?:\.\d+)?$/.test(input.value) ? `${input.value}px` : input.value;
    if (tiptapEditor) {
      // Tiptap의 TextStyle mark는 선택 범위를 정확히 span으로 직렬화하므로,
      // 문단 전체에 font-size가 적용되는 contenteditable fallback을 쓰지 않는다.
      tiptapEditor.chain().focus().setMark('textStyle', { fontSize:size }).run();
      syncFromVisual();
      updateToolbarState();
      return;
    }
    if (hasTextSelection) {
      const span = applyVisualSelectionStyle(range, 'font-size', size);
      if (span) {
        syncFromVisual();
        keepVisualSelection(span);
        updateToolbarState();
        return;
      }
    }
    if (!hasTextSelection && activeBlock) {
      activeBlock.style.fontSize = size;
      syncFromVisual();
      updateToolbarState();
      return;
    }
    const existingFontTags = new Set(visualEditor.querySelectorAll('font[size="7"]'));
    const sizedSpans = [];
    document.execCommand('fontSize', false, '7');
    visualEditor.querySelectorAll('font[size="7"]').forEach((font) => {
      if (existingFontTags.has(font)) return;
      const span = document.createElement('span');
      span.style.fontSize = size;
      span.innerHTML = font.innerHTML;
      font.replaceWith(span);
      sizedSpans.push(span);
    });
    syncFromVisual();
    // 새 span으로 바뀐 뒤에도 같은 텍스트를 선택 상태로 유지한다. 이어서 색상,
    // 굵기 등 다른 서식을 선택해도 재드래그할 필요가 없다.
    if (sizedSpans.length) keepVisualSelection(sizedSpans[0], sizedSpans.at(-1));
    else rememberVisualRange();
    updateToolbarState();
  });
  fontSizeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  fontSizeInput.addEventListener('pointerdown', () => {
    rememberVisualRange();
    // Tiptap은 선택 범위와 span mark를 자체 transaction으로 관리한다.
    if (!tiptapEditor) materialiseVisualSelection();
  }, true);
  fontSizeInput.addEventListener('blur', (event) => {
    event.target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  richToolbar.querySelector('[data-font-family]').addEventListener('change', (event) => {
    const fontFamily = event.target.value;
    if (tiptapEditor) {
      const chain = tiptapEditor.chain().focus();
      if (fontFamily) chain.setMark('textStyle', { fontFamily }).run();
      // Clearing only the font family must retain text size and colour in
      // this TextStyle mark. unsetMark removes every typography attribute.
      else chain.setMark('textStyle', { fontFamily:null }).run();
      syncFromVisual();
      updateToolbarState();
      return;
    }
    const selection = window.getSelection();
    const node = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const block = activeBlock || editableBlock(node);
    if (!block) return;
    if (fontFamily) block.style.fontFamily = fontFamily;
    else block.style.removeProperty('font-family');
    syncFromVisual();
    updateToolbarState();
  });
  richToolbar.querySelector('[data-list]').addEventListener('change', (event) => {
    if (!event.target.value) return;
    if (tiptapEditor) {
      const requested = event.target.value;
      tiptapEditor.commands.focus();
      const chain = tiptapEditor.chain();
      const ordered = orderedListSelection();
      if (requested === 'disc') chain.toggleBulletList().run();
      else if (ordered) {
        const node = ordered.$from.node(ordered.depth);
        const style = requested === 'decimal' ? null : `list-style-type: ${requested}`;
        tiptapEditor.view.dispatch(tiptapEditor.state.tr.setNodeMarkup(ordered.$from.before(ordered.depth), undefined, { ...node.attrs, style }));
      } else chain.toggleOrderedList().run();
      syncFromVisual();
      updateToolbarState();
      return;
    }
    visualEditor.focus();
    if (event.target.value === 'disc') document.execCommand('insertUnorderedList', false, null);
    else {
      document.execCommand('insertOrderedList', false, null);
      const node = window.getSelection()?.anchorNode?.nodeType === Node.ELEMENT_NODE ? window.getSelection().anchorNode : window.getSelection()?.anchorNode?.parentElement;
      node?.closest('ol')?.style.setProperty('list-style-type', event.target.value);
    }
    syncFromVisual();
  });
  richToolbar.querySelector('input[type="color"]').addEventListener('input', (event) => {
    if (tiptapEditor) {
      tiptapEditor.chain().focus().setColor(event.target.value).run();
      syncFromVisual();
      return;
    }
    const range = storedVisualRange();
    if (!range) visualEditor.focus();
    const span = range && !range.collapsed ? applyVisualSelectionStyle(range, 'color', event.target.value) : null;
    if (!span) document.execCommand('foreColor', false, event.target.value);
    syncFromVisual();
    if (span) keepVisualSelection(span);
    else rememberVisualRange();
  });
  editorTools = mountEditorTools({
    toolbar:richToolbar, getEditor:() => tiptapEditor, cssEditor,
    canEdit:() => Boolean(tiptapEditor?.isEditable && !visualEditor.hidden && !isCoverSelected() && visualLoadedChapterId === bookProject.selectedChapterId),
    onError:message => setStatus(message, 'error'),
  });
  const runHistory = (redo) => {
    const model = window.epubMonacoEditor?.getModel();
    if (!model || !bookProject.selectedChapter) return;
    model.pushStackElement();
    if (redo ? model.canRedo() : model.canUndo()) model[redo ? 'redo' : 'undo']();
    updateToolbarState();
  };
  for (const button of historyButtons) {
    mode.append(button);
    button.addEventListener('click', () => runHistory(button.dataset.editorAction === 'redo'));
  }
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !['z','y'].includes(event.key.toLowerCase())) return;
    if (visualEditor.hidden || !visualEditor.contains(document.activeElement)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    runHistory(event.shiftKey || event.key.toLowerCase() === 'y');
  }, true);
  // textarea는 장 전환·미리보기·임시저장의 기존 데이터 브리지로 유지하고, HTML 모드의
  // 실제 편집 UI만 Monaco로 대체한다. Monaco를 못 받아도 textarea가 그대로 동작한다.
  const installMonacoEditor = () => {
    if (!window.require || window.epubMonacoEditor) return;
    window.require.config({ paths:{ vs:`${location.origin}/dist/monaco/vs` } });
    window.require(['vs/editor/editor.main'], () => {
      const monaco = window.monaco;
      if (!monaco || window.epubMonacoEditor) return;
      const monacoTheme = installMonacoTheme(monaco);
      const host = document.createElement('div');
      host.id = 'xhtml-monaco-editor';
      host.setAttribute('aria-label', 'XHTML 코드 편집기');
      codeEditor.append(host);
      const tags = ['html','head','body','title','meta','link','style','script','div','section','article','header','footer','main','nav','aside','p','span','strong','em','b','i','u','h1','h2','h3','h4','h5','h6','ul','ol','li','table','thead','tbody','tr','th','td','a','img','figure','figcaption','br','hr'];
      monaco.languages.registerCompletionItemProvider('html', {
        triggerCharacters:['<',' ','.',':'],
        provideCompletionItems(model, position) {
          const context = xhtmlCompletionContext(model.getValue(), model.getOffsetAt(position));
          if (context.attributes) {
            return { suggestions:monacoAttributeSuggestions(monaco, model, position) };
          }
          if (!context.emmet) return { suggestions:[] };
          return { suggestions:tags.map((tag) => {
            const voidTag = xhtmlVoidTags.has(tag);
            const defaultAttributes = tag === 'img' ? ' src="$1" alt="$2"' : '';
            return {
              label:tag, kind:monaco.languages.CompletionItemKind.Snippet,
              detail:voidTag ? 'XHTML self-closing tag' : 'XHTML tag',
              insertText:voidTag ? `<${tag}${defaultAttributes} />` : `<${tag}>$0</${tag}>`,
              insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            };
          }) };
        },
      });
      const editor = monaco.editor.create(host, {
        value:htmlEditor.value, language:'html', theme:monacoTheme,
        automaticLayout:true, minimap:{ enabled:false }, lineNumbers:'on', lineNumbersMinChars:2,
        glyphMargin:false, lineDecorationsWidth:0, fontSize:13, tabSize:2,
        insertSpaces:true, wordWrap:'on', quickSuggestions:true, suggestOnTriggerCharacters:true,
        tabCompletion:'on', autoClosingBrackets:'always', autoClosingQuotes:'always', formatOnPaste:false,
      });
      window.epubMonacoEditor = editor;
      editor.addAction({id:'epub.history.redo',label:'다시 실행',keybindings:[monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyY],precondition:'editorTextFocus',run:() => runHistory(true)});
      let monacoPointerFocus = false;
      // Monaco moves the cursor before its onMouseDown notification. Capture
      // the native pointer event first so click sync can animate without
      // animating keyboard navigation.
      host.addEventListener('pointerdown', () => { monacoPointerFocus = true; }, true);
      host.addEventListener('pointerup', () => { monacoPointerFocus = false; }, true);
      host.addEventListener('pointercancel', () => { monacoPointerFocus = false; }, true);
      host.addEventListener('pointerleave', () => { monacoPointerFocus = false; }, true);
      editor.onDidChangeCursorPosition(event => {
        if (isFocusSyncing() || event.reason !== monaco.editor.CursorChangeReason.Explicit) return;
        if (editor.getValue() !== htmlEditor.value) return;
        const offset = editor.getModel().getOffsetAt(event.position);
        const node = elementAtOffset(htmlEditor.value, offset);
        synchronizeFocus(node, 'monaco', sourceTextOffset(node, offset), monacoPointerFocus);
      });
      let synchronising = false;
      const history = createChapterHistory(monaco, bookProject);
      const initialModel = editor.getModel();
      window.recordChapterEdit = (chapter, source, separate = false) => {
        const previous = synchronising;
        synchronising = true;
        try { return history.record(chapter, source, separate); }
        finally { synchronising = previous; updateToolbarState(); }
      };
      window.loadXhtmlMonaco = value => {
        synchronising = true;
        try {
          editor.getModel()?.pushStackElement();
          const model = history.record(bookProject.selectedChapter, value);
          if (editor.getModel() !== model) editor.setModel(model);
        } finally { synchronising = false; updateToolbarState(); }
      };
      window.loadXhtmlMonaco(htmlEditor.value);
      if (initialModel !== editor.getModel()) initialModel.dispose();
      // Source is canonical; entering a mode must not format or create an undo step.
      window.formatXhtmlMonacoForDisplay = async () => {};
      // Disable Monaco's HTML formatter: it wraps prose. All menu/palette/key
      // bindings now resolve to this single, source-preserving provider.
      monaco.languages.html.htmlDefaults.setModeConfiguration({
        ...monaco.languages.html.htmlDefaults.modeConfiguration,
        documentFormattingEdits:false, documentRangeFormattingEdits:false,
      });
      monaco.languages.registerDocumentFormattingEditProvider('html', {
        provideDocumentFormattingEdits(model) {
          const before = model.getValue();
          const invalid = validateXhtml(before);
          if (invalid.length) { setStatus(`서식 정리 중단: ${invalid[0].message}`, 'error'); return []; }
          const after = formatXhtml(before);
          if (!equivalentXhtml(before,after,DOMParser,{preserveWhitespace:/white-space\s*:/i.test(cssEditor.value)})) { setStatus('서식 정리가 공백 또는 구조를 변경할 수 있어 원문을 유지했습니다.', 'error'); return []; }
          return before === after ? [] : [{range:model.getFullModelRange(),text:after}];
        },
      });
      editor.addAction({
        id:'epub.xhtml.format', label:'XHTML 서식 정리',
        precondition:'editorTextFocus',
        run:() => editor.getAction('editor.action.formatDocument').run(),
      });

      const syncTextareaFromMonaco = () => {
        if (synchronising) return;
        synchronising = true;
        htmlEditor.value = editor.getValue();
        htmlEditor.dispatchEvent(new Event('input', { bubbles:true }));
        synchronising = false;
      };
      editor.onDidChangeModelContent((event) => {
        if (synchronising || hydratingChapter) return;
        syncTextareaFromMonaco();
        if (!visualEditor.hidden) setVisualHtml(htmlEditor.value);
        updateToolbarState();
      });
      htmlEditor.addEventListener('input', () => {
        if (synchronising || editor.getValue() === htmlEditor.value) return;
        window.loadXhtmlMonaco(htmlEditor.value);
      });
      void window.formatXhtmlMonacoForDisplay();
      const addEmmetLibrary = () => {
        const activate = () => {
          if (!window.emmetMonaco) return;
          window.emmetMonaco.registerCustomSnippets?.('html', {
            br:'<br />', hr:'<hr />', img:'<img src="${1}" alt="${2}" />', input:'<input type="${1}" />',
            meta:'<meta charset="UTF-8" />', link:'<link rel="stylesheet" href="${1}" type="text/css" />',
          });
          registerXhtmlEmmet(monaco, window.emmetMonaco);
          window.emmetMonaco.emmetCSS?.(monaco, ['css']);
        };
        if (window.emmetMonaco) return activate();
        const script = document.createElement('script');
        script.src = '/dist/emmet-monaco.min.js';
        script.onload = activate;
        script.onerror = () => console.warn('Emmet 라이브러리를 불러오지 못했습니다.');
        document.head.append(script);
      };
      addEmmetLibrary();
      const cssHost = document.createElement('div');
      cssHost.id = 'css-monaco-editor';
      cssHost.setAttribute('aria-label', '공통 CSS 편집기');
      cssEditor.before(cssHost);
      const cssMonacoEditor = monaco.editor.create(cssHost, {
        value:cssEditor.value, language:'css', theme:monacoTheme,
        renderLineHighlight:'none',
        automaticLayout:true, minimap:{ enabled:false }, lineNumbers:'on', lineNumbersMinChars:2,
        glyphMargin:false, fontSize:13, tabSize:2, insertSpaces:true, wordWrap:'on',
        quickSuggestions:true, suggestOnTriggerCharacters:true, tabCompletion:'on', formatOnPaste:true,
      });
      window.epubCssMonacoEditor = cssMonacoEditor;
      window.emmetMonaco?.emmetCSS?.(monaco, ['css']);
      let syncingCss = false;
      cssMonacoEditor.onDidChangeModelContent(() => {
        if (syncingCss) return;
        syncingCss = true;
        cssEditor.value = cssMonacoEditor.getValue();
        cssEditor.dispatchEvent(new Event('input', { bubbles:true }));
        syncingCss = false;
      });
      cssEditor.addEventListener('input', () => {
        if (syncingCss || cssMonacoEditor.getValue() === cssEditor.value) return;
        syncingCss = true;
        cssMonacoEditor.setValue(cssEditor.value);
        syncingCss = false;
      });
      const expandCssEmmet = () => {
        const model = cssMonacoEditor.getModel();
        const position = cssMonacoEditor.getPosition();
        const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const match = /([^\s{};]+)$/.exec(before);
        if (!match || !window.emmetMonaco?.expandAbbreviation) return false;
        try {
          const expanded = window.emmetMonaco.expandAbbreviation(match[1], { type:'stylesheet', syntax:'css' });
          if (!expanded || expanded === match[1]) return false;
          const start = new monaco.Position(position.lineNumber, position.column - match[1].length);
          cssMonacoEditor.executeEdits('css-emmet', [{ range:new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column), text:expanded }]);
          return true;
        } catch { return false; }
      };
      cssMonacoEditor.addAction({
        id:'epub.css.tab', label:'CSS Emmet 확장 또는 들여쓰기', keybindings:[monaco.KeyCode.Tab], precondition:'editorTextFocus',
        run:() => expandCssEmmet() || cssMonacoEditor.getAction('editor.action.indentLines')?.run(),
      });
      chapterHeader.querySelector('[data-panel="cssPanel"]')?.addEventListener('click', () => requestAnimationFrame(() => cssMonacoEditor.layout()));
      const expandEmmet = () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!xhtmlCompletionContext(model.getValue(), model.getOffsetAt(position)).emmet) return false;
        const line = model.getLineContent(position.lineNumber);
        const before = line.slice(0, position.column - 1);
        const match = /([A-Za-z][A-Za-z0-9:._#>+*${}\[\]="'-]*)$/.exec(before);
        if (!match || !window.emmetMonaco?.expandAbbreviation) return false;
        try {
          let expanded = window.emmetMonaco.expandAbbreviation(match[1], { type:'markup', syntax:'html', options:{ 'output.selfClosingStyle':'xhtml' } });
          if (!expanded || expanded === match[1]) return false;
          expanded = normaliseXhtml(expanded.replace(/\|/g, ''));
          const start = new monaco.Position(position.lineNumber, position.column - match[1].length);
          editor.executeEdits('xhtml-emmet', [{ range:new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column), text:expanded }]);
          return true;
        } catch { return false; }
      };
      editor.addAction({
        id:'epub.xhtml.tab', label:'XHTML Emmet 확장 또는 들여쓰기',
        keybindings:[monaco.KeyCode.Tab], precondition:'editorTextFocus && !suggestWidgetVisible && !inSnippetMode',
        run:() => {
          const model = editor.getModel();
          const position = editor.getPosition();
          if (xhtmlCompletionContext(model.getValue(), model.getOffsetAt(position)).attributes) {
            const suggestions = monacoAttributeSuggestions(monaco, model, position);
            const match = suggestions.find(item => {
              const prefix = model.getValueInRange({ ...item.range, endLineNumber:position.lineNumber, endColumn:position.column });
              return prefix && item.label.startsWith(prefix);
            });
            if (match) {
              editor.setSelection(match.range);
              editor.getContribution('snippetController2').insert(match.insertText);
              return;
            }
            if (suggestions.length) return editor.getAction('editor.action.triggerSuggest')?.run();
          }
          if (expandEmmet()) return;
          return editor.getAction('editor.action.indentLines')?.run();
        },
      });
      // 기존 코드가 textarea에 포커스를 이동시키는 경우에도 사용자는 Monaco에서 계속 편집한다.
      htmlEditor.focus = () => editor.focus();
    });
  };
  const installTiptapVisualEditor = async () => {
    try {
      // CDN의 ESM 번들을 사용하므로 이 정적 앱의 저장/배포 구조는 바꾸지 않는다.
      const [coreModule, starterModule, textStyleModule, colorModule, imageModule, tableModule, tableRowModule, tableCellModule, tableHeaderModule, alignModule, superModule, subModule, linkModule, underlineModule, orderedListModule] = await Promise.all([
        import('https://esm.sh/@tiptap/core@2.11.5'),
        import('https://esm.sh/@tiptap/starter-kit@2.11.5'),
        import('https://esm.sh/@tiptap/extension-text-style@2.11.5'),
        import('https://esm.sh/@tiptap/extension-color@2.11.5'),
        import('https://esm.sh/@tiptap/extension-image@2.11.5'),
        import('https://esm.sh/@tiptap/extension-table@2.11.5'),
        import('https://esm.sh/@tiptap/extension-table-row@2.11.5'),
        import('https://esm.sh/@tiptap/extension-table-cell@2.11.5'),
        import('https://esm.sh/@tiptap/extension-table-header@2.11.5'),
        import('https://esm.sh/@tiptap/extension-text-align@2.11.5'),
        import('https://esm.sh/@tiptap/extension-superscript@2.11.5'),
        import('https://esm.sh/@tiptap/extension-subscript@2.11.5'),
        import('https://esm.sh/@tiptap/extension-link@2.11.5'),
        import('https://esm.sh/@tiptap/extension-underline@2.11.5'),
        import('https://esm.sh/@tiptap/extension-ordered-list@2.11.5'),
      ]);
      const Editor = coreModule.Editor;
      const Extension = coreModule.Extension;
      const Node = coreModule.Node;
      const Mark = coreModule.Mark;
      const StarterKit = starterModule.default;
      const TextStyle = textStyleModule.default;
      const OrderedList = orderedListModule.default;
      if (!Editor || !StarterKit || !TextStyle || !OrderedList) throw new Error('Tiptap module unavailable');
      const textStyleProperties = ['font-size','font-family','color'];
      const epubSpanAttrs = element => {
        const style = document.createElement('span').style;
        style.cssText = element.getAttribute('style') || '';
        textStyleProperties.forEach(property => style.removeProperty(property));
        const attrs = {
          class:element.getAttribute('class'), id:element.getAttribute('id'),
          style:style.cssText || null,
          'data-footnote-content':element.getAttribute('data-footnote-content'),
        };
        // A span containing only TextStyle properties is represented by the
        // TextStyle mark alone. Parsing it as epubSpan as well creates nested
        // spans and makes a later XHTML safety check see a false structural
        // change.
        return Object.values(attrs).some(Boolean) ? attrs : false;
      };
      const InlineStyle = TextStyle.extend({
        addGlobalAttributes() {
          return [{
            types:['textStyle'],
            attributes:{
              fontSize:{ default:null, parseHTML:(element) => element.style.fontSize || null, renderHTML:(attributes) => attributes.fontSize ? { style:`font-size: ${attributes.fontSize}` } : {} },
              fontFamily:{ default:null, parseHTML:(element) => element.style.fontFamily || null, renderHTML:(attributes) => attributes.fontFamily ? { style:`font-family: ${attributes.fontFamily}` } : {} },
            },
          }];
        },
      });
      // EPUB 본문에 흔한 div/span의 class·id·style을 일반편집을 거쳤다는 이유로
      // 버리지 않도록 최소 보존 확장을 함께 등록한다.
      const Div = Node.create({
        name:'epubDiv', group:'block', content:'block*', defining:true,
        addAttributes:() => ({ class:{default:null}, id:{default:null}, style:{default:null} }),
        parseHTML:() => [{ tag:'div' }], renderHTML:({ HTMLAttributes }) => ['div', HTMLAttributes, 0],
      });
      const Span = Mark.create({
        name:'epubSpan', inclusive:false,
        addAttributes:() => ({ class:{default:null}, id:{default:null}, style:{default:null}, 'data-footnote-content':{default:null} }),
        parseHTML:() => [{ tag:'span', consuming:false, priority:110, getAttrs:epubSpanAttrs }],
        renderHTML:({ HTMLAttributes }) => ['span', { ...HTMLAttributes, 'data-sitescout-epub-span-projection':'true' }, 0],
      });
      const StyledOrderedList = OrderedList.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            style:{ default:null, parseHTML:element => element.getAttribute('style'), renderHTML:attributes => attributes.style ? { style:attributes.style } : {} },
          };
        },
      });
      const Aside = Node.create({
        name:'epubAside', group:'block', content:'block*', defining:true,
        addAttributes:() => ({ id:{default:null}, 'epub:type':{default:null} }),
        parseHTML:() => [{ tag:'aside' }], renderHTML:({ HTMLAttributes }) => ['aside', HTMLAttributes, 0],
      });
      const Section = Node.create({
        name:'epubSection', group:'block', content:'block*', defining:true,
        addAttributes:() => ({ id:{default:null}, 'epub:type':{default:null} }),
        parseHTML:() => [{ tag:'section' }], renderHTML:({ HTMLAttributes }) => ['section', HTMLAttributes, 0],
      });
      const PreserveAttributes = Extension.create({
        name:'epubPreserveAttributes',
        addGlobalAttributes() {
          return [{
            types:['paragraph','heading','blockquote','bulletList','orderedList','listItem','table','tableRow','tableCell','tableHeader','image','link'],
            attributes:{
              class:{ default:null, parseHTML:(element) => element.getAttribute('class'), renderHTML:(attributes) => attributes.class ? { class:attributes.class } : {} },
              id:{ default:null, parseHTML:(element) => element.getAttribute('id'), renderHTML:(attributes) => attributes.id ? { id:attributes.id } : {} },
              style:{ default:null, parseHTML:(element) => element.getAttribute('style'), renderHTML:(attributes) => attributes.style ? { style:attributes.style } : {} },
              'epub:type':{ default:null, parseHTML:(element) => element.getAttribute('epub:type'), renderHTML:(attributes) => attributes['epub:type'] ? { 'epub:type':attributes['epub:type'] } : {} },
              'data-sitescout-footnote':{ default:null, parseHTML:(element) => element.getAttribute('data-sitescout-footnote'), renderHTML:(attributes) => attributes['data-sitescout-footnote'] ? { 'data-sitescout-footnote':attributes['data-sitescout-footnote'] } : {} },
            },
          }];
        },
      });
      const StyleShortcuts = Extension.create({
        name:'projectStyleShortcuts', priority:1000,
        addKeyboardShortcuts() {
          return styleShortcutBindings(bookProject, style => {
            if (visualEditor.hidden || isCoverSelected() || !this.editor.isEditable || this.editor.view.composing
              || visualLoadedChapterId !== bookProject.selectedChapterId) return false;
            return style.kind === 'tag' ? applyTagStyle(this.editor, style.tag) : applyCustomStyle(this.editor, style);
          });
        },
      });
      // Tiptap's resizable TableView owns the DOM; mirror persisted attributes
      // into that view without replacing its cells or resizing implementation.
      class PreservedTableView extends tableModule.default.options.View {
        constructor(node, cellMinWidth, view) {
          super(node, cellMinWidth, view);
          this.update(node);
        }
        update(node) {
          if (node.type !== this.node.type) return false;
          for (const name of ['id','class','style','epub:type']) {
            if (node.attrs[name]) this.table.setAttribute(name,node.attrs[name]);
            else this.table.removeAttribute(name);
          }
          return super.update(node);
        }
      }
      // Remove any legacy read-only shell before ProseMirror mounts, so the
      // rich editor has exactly one document and no preserved sibling content.
      visualEditor.replaceChildren();
      tiptapEditor = new Editor({
        element:visualEditor,
        extensions:[
          StarterKit.configure({ link:false, underline:false, history:false, orderedList:false }), InlineStyle,
          Extension.create({ name:'documentSearch', addProseMirrorPlugins:() => [editorSearchPlugin()] }),
          colorModule.default.configure({ types:['textStyle'] }), imageModule.default,
          tableModule.default.configure({ resizable:true, View:PreservedTableView }), tableRowModule.default, tableHeaderModule.default, tableCellModule.default,
          alignModule.default.configure({ types:['heading','paragraph'] }), superModule.default, subModule.default, StyledOrderedList,
          linkModule.default.configure({ openOnClick:false, HTMLAttributes:{ target:null, rel:null } }), underlineModule.default, Div, Span, Aside, Section, PreserveAttributes, StyleShortcuts,
        ],
        content:htmlEditor.value,
        parseOptions:{ preserveWhitespace:'full' },
        onUpdate:({ editor:instance }) => {
          syncFromVisual({ normalise:false });
        },
        onSelectionUpdate:({ editor:instance, transaction }) => {
          if (isFocusSyncing() || visualEditor.hidden || visualLoadedChapterId !== bookProject.selectedChapterId) return;
          const { from } = instance.state.selection;
          const dom = instance.view.domAtPos(from).node;
          const element = dom.nodeType === Node.ELEMENT_NODE ? dom : dom.parentElement;
          const block = element?.closest(previewBlockSelector + ',a,span,strong,em');
          const node = sourceNodeForElement(block, visualEditor);
          synchronizeFocus(node, 'visual', previewTextOffset(block, dom, instance.view.domAtPos(from).offset), transaction.getMeta('pointer') === true);
          updateToolbarState();
        },
      });
      const clipboardParser = ProseMirrorDOMParser.fromSchema(tiptapEditor.schema);
      tiptapEditor.setOptions({editorProps:{clipboardParser:{
        parseSlice:(dom,options) => clipboardParser.parseSlice(dom,{...options,preserveWhitespace:'full'}),
      }}});
      visualEditor.addEventListener('paste', event => {
        const html = event.clipboardData?.getData('text/html');
        if (!html || !tiptapEditor.isEditable) return;
        try {
          const body = new DOMParser().parseFromString(html,'text/html').body;
          const walker = document.createTreeWalker(body,NodeFilter.SHOW_COMMENT);
          const markers = []; while(walker.nextNode()) if (/^(?:Start|End)Fragment$/.test(walker.currentNode.data.trim())) markers.push(walker.currentNode);
          markers.forEach(node => node.remove());
          const parsed = clipboardParser.parseSlice(body,{preserveWhitespace:'full'});
          const output = document.createElement('div');
          output.append(ProseMirrorDOMSerializer.fromSchema(tiptapEditor.schema).serializeFragment(parsed.content));
          const issue = xhtmlPreservationIssue(serializeVisualXhtml(body.innerHTML),serializeVisualXhtml(output.innerHTML));
          if (issue) throw new Error(issue);
        } catch(error) {
          event.preventDefault(); event.stopImmediatePropagation();
          setStatus(`붙여넣기를 중단했습니다. ${error.message} XHTML편집을 사용하세요.`, 'error');
        }
      },true);
      setVisualHtml(htmlEditor.value);
      visualEditor.removeAttribute('contenteditable');
    } catch (error) {
      console.warn('Tiptap 일반편집기를 불러오지 못했습니다.', error);
      visualEditor.setAttribute('aria-disabled', 'true');
      setStatus('일반편집기를 불러오지 못했습니다. XHTML 편집을 사용하거나 다시 접속하세요.', 'error');
    }
  };
  installMonacoEditor();
  void installTiptapVisualEditor();
  setMode('visual');
  if (!bookProject.chapters.length) newBookButton.click();
  initializingWorkspace = false;
  bookProject.dirty = false;
  ['title','author','language','ctitle','clevel'].forEach(id => document.getElementById(id).addEventListener('input', () => {
    bookProject.dirty = true; bookProject.revision++;
  }));
  window.addEventListener('beforeunload', event => {
    if (!bookProject.dirty && !saveInFlight) return;
    event.preventDefault();
    event.returnValue = '';
  });
  const refreshServerAuthority = async () => {
    await verifyAccess();
    if (!isAccessVerified()) return;
    await restoreCloudDrafts();
    if (bookProject.serverRevision > 0) await ensureEditLease({quiet:true});
  };
  window.addEventListener('online', () => { void refreshServerAuthority(); });
  window.addEventListener('offline', () => { setProjectEditingAccess(false,'통신이 끊겨 편집 권한을 잠갔습니다. 현재 탭의 원고는 유지됩니다.'); });
  window.addEventListener('focus', () => { void refreshServerAuthority(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshServerAuthority();
  });
  void refreshAccountUi();
  void restoreCloudDrafts();
  chapterControls.classList.add('active');
  updateLineNumbers();
  validateHtml();
  mountAppSidebar({
    app, side, main:app.querySelector('main'),
    nodes:{ projects:editorTab, drafts:draftsPanel, account:accountArea },
  });
  markAppUiReady();
  // Tooltips are optional presentation: a CDN failure must not block editing.
  void import('./theme-tooltip.js?v=20261007-75').then(({installThemeTooltips}) => installThemeTooltips())
    .catch(error => console.warn('테마 툴팁을 불러오지 못했습니다. 기본 툴팁을 유지합니다.', error));
}
