// Text-style settings UI. Depends on BookProject style definitions and a dynamic, editor-scoped CSS sheet.
// Check dialog layout, theme, shortcuts, and style application after changes.
import { validateStyle, styleTags } from './text-styles.js';
import { shortcutFromEvent, validateStyleShortcut, displayStyleShortcut, readStyleShortcut } from './style-shortcuts.js';

export function mountTextStyles({ project, toolbar, cssEditor, onError }) {
  const select = toolbar.querySelector('[data-heading]');
  const sheet = document.createElement('style');
  sheet.dataset.editorTypography = '';
  document.head.append(sheet);
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '텍스트 스타일 설정');
  dialog.innerHTML = `<form method="dialog">
    <header class="style-dialog-header">
      <span class="style-dialog-mark" aria-hidden="true">Aa</span>
      <div><h2>텍스트 스타일 설정</h2><p>새 스타일을 만들거나 기존 스타일을 다듬어보세요.</p></div>
    </header>
    <div class="style-dialog-body">
      <div class="style-dialog-picker"><label class="style-field"><span>스타일</span><select name="style" autofocus></select></label></div>
      <div class="style-field-group">
        <label class="style-field"><span>라벨</span><input name="label" required maxlength="100" placeholder="예: 강조문"></label>
        <div class="style-field"><span>대상 종류</span><div class="style-target-kind">
          <label><input type="radio" name="kind" value="class" checked> CSS 클래스</label>
          <label><input type="radio" name="kind" value="tag"> 태그</label>
        </div></div>
        <label class="style-field"><span data-target-label>CSS 클래스명</span><input name="target" required placeholder="예: highlight-text"></label>
        <p class="style-dialog-hint" data-target-hint>외형은 공통 CSS에서 설정합니다.</p>
      </div>
      <div class="style-field-group">
        <div class="style-field"><label for="style-shortcut-input">단축키</label><div class="style-shortcut-control">
          <input id="style-shortcut-input" name="shortcut" readonly placeholder="클릭 후 키 조합을 누르세요" aria-describedby="style-shortcut-help">
          <button type="button" data-shortcut-clear aria-label="단축키 해제">해제</button>
        </div></div>
        <p class="style-dialog-hint" id="style-shortcut-help">Ctrl/Cmd + Alt + 숫자를 권장합니다.<br>일반편집 본문에서 사용할 수 있습니다.</p>
      </div>
      <p class="style-dialog-note">CSS 클래스는 선택한 텍스트 또는 현재 블록에 적용됩니다. 태그는 현재 블록의 태그를 바꿉니다. 외형은 공통 CSS에서 설정하세요.</p>
      <p role="alert" data-style-error></p>
    </div>
    <footer class="style-dialog-footer">
      <button type="button" data-style-delete>스타일 삭제</button>
      <div><button type="button" data-style-close>닫기</button><button type="submit">저장</button></div>
    </footer>
  </form>`;
  dialog.className = 'text-style-dialog';
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const fields = form.elements;
  let openedStyles = null;
  const all = () => [...project.typographyStyles, ...project.customStyles];
  const renderCss = () => { sheet.textContent = cssEditor.value ? `@scope (.rich-editor .ProseMirror) { ${cssEditor.value} }` : ''; };
  cssEditor.addEventListener('input', renderCss);
  function render() {
    const value = select.value;
    select.replaceChildren();
    project.typographyStyles.forEach(style => select.add(new Option(style.label, style.tag === 'p' ? '' : style.tag)));
    if (project.customStyles.length) {
      const group = document.createElement('optgroup'); group.label = '사용자 정의';
      project.customStyles.forEach(style => group.append(new Option(style.label, `custom:${style.id}`)));
      select.append(group);
    }
    select.add(new Option('+ 스타일 추가', 'add-style'));
    select.value = Array.from(select.options).some(option => option.value === value) ? value : '';
    renderCss();
    if (dialog.open && openedStyles !== project.typographyStyles) dialog.close();
  }
  function fill() {
    const style = all().find(item => item.id === fields.style.value);
    fields.label.value = style?.label || '';
    fields.shortcut.value = displayStyleShortcut(style?.shortcut);
    form.querySelector(`input[name="kind"][value="${style?.kind === 'tag' ? 'tag' : 'class'}"]`).checked = true;
    fields.target.value = style?.tag || style?.className || '';
    fields.target.disabled = Boolean(style);
    form.querySelectorAll('input[name="kind"]').forEach(input => { input.disabled = Boolean(style); });
    updateTarget();
    dialog.querySelector('[data-style-delete]').hidden = !style || project.typographyStyles.includes(style);
    dialog.querySelector('[data-style-error]').textContent = '';
  }
  function updateTarget() {
    const tag = form.querySelector('input[name="kind"]:checked').value === 'tag';
    dialog.querySelector('[data-target-label]').textContent = tag ? '태그명' : 'CSS 클래스명';
    dialog.querySelector('[data-target-hint]').textContent = tag ? `사용 가능한 태그: ${styleTags.join(', ')}. 외형은 공통 CSS에서 설정합니다.` : '외형은 공통 CSS에서 설정합니다.';
    fields.target.placeholder = tag ? '예: blockquote' : '예: highlight-text';
  }
  function open(add = false) {
    openedStyles = project.typographyStyles;
    fields.style.replaceChildren(...all().map(style => new Option(style.label, style.id)), new Option('+ 스타일 추가', 'new'));
    fields.style.value = add ? 'new' : project.typographyStyles.find(style => (style.tag === 'p' ? '' : style.tag) === select.value)?.id || project.customStyles.find(style => `custom:${style.id}` === select.value)?.id || 'h1';
    fill(); dialog.showModal();
  }
  function commit(typographyStyles, customStyles) {
    if (openedStyles !== project.typographyStyles) { dialog.close(); return; }
    project.typographyStyles = typographyStyles; project.customStyles = customStyles;
    openedStyles = typographyStyles;
    project.dirty = true; project.revision++;
    render(); dialog.close();
  }
  fields.style.addEventListener('change', fill);
  form.querySelectorAll('input[name="kind"]').forEach(input => input.addEventListener('change', () => { fields.target.value = ''; updateTarget(); }));
  fields.shortcut.addEventListener('keydown', event => {
    if (['Tab','Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (['Control','Meta','Alt','Shift'].includes(event.key)) return;
    const error = dialog.querySelector('[data-style-error]');
    if (['Backspace','Delete'].includes(event.key)) { fields.shortcut.value = ''; error.textContent = ''; return; }
    try {
      const shortcut = shortcutFromEvent(event);
      if (shortcut === null) return;
      fields.shortcut.value = displayStyleShortcut(validateStyleShortcut(shortcut, all(), fields.style.value));
      error.textContent = '';
    } catch (problem) { error.textContent = problem.message; }
  });
  dialog.querySelector('[data-shortcut-clear]').addEventListener('click', () => {
    fields.shortcut.value = '';
    dialog.querySelector('[data-style-error]').textContent = '';
  });
  dialog.querySelector('[data-style-close]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const existing = all().find(style => style.id === fields.style.value);
      const kind = form.querySelector('input[name="kind"]:checked').value;
      const target = fields.target.value.trim();
      const style = { ...(existing || { id:crypto.randomUUID(), kind, ...(kind === 'tag' ? { tag:target.toLowerCase() } : { className:target }) }), label:fields.label.value.trim() };
      style.shortcut = validateStyleShortcut(readStyleShortcut(fields.shortcut.value), all(), style.id);
      validateStyle(style, !project.typographyStyles.some(item => item.id === style.id));
      if (!existing && all().some(item => item.kind === style.kind && (style.kind === 'tag' ? item.tag === style.tag : item.className === style.className))) throw new Error('이미 등록된 적용 대상입니다.');
      commit(project.typographyStyles.some(item => item.id === style.id) ? project.typographyStyles.map(item => item.id === style.id ? style : item) : project.typographyStyles,
        project.typographyStyles.some(item => item.id === style.id) ? project.customStyles : existing ? project.customStyles.map(item => item.id === style.id ? style : item) : [...project.customStyles, style]);
    } catch (error) { dialog.querySelector('[data-style-error]').textContent = error.message; }
  });
  dialog.querySelector('[data-style-delete]').addEventListener('click', () => {
    if (!window.confirm('이 스타일이 본문에 사용 중일 수 있습니다. 설정만 삭제하고 본문과 공통 CSS는 유지합니다.')) return;
    try { commit(project.typographyStyles, project.customStyles.filter(style => style.id !== fields.style.value)); }
    catch (error) { onError(error.message); }
  });
  render();
  return { render, open };
}
