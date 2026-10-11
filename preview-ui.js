// Workspace preview: device frame, sandbox render, and editor/preview focus mapping.
// Receives BookProject and editor callbacks from ui.js; verify preview, chapter links, and caret sync after changes.
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.16/+esm";
import {
  sourceElements,
  sourceAttribute,
  elementAtPath,
} from "./xhtml-source.js?v=20261007-70";

export function mountPreviewDevice(preview) {
  let previewIframe = null;
  const previewContentRoot = () =>
    previewIframe?.isConnected
      ? previewIframe.contentDocument?.body || preview
      : preview;
  const previewScrollRoot = () =>
    previewIframe?.isConnected
      ? previewIframe.contentDocument?.scrollingElement || previewContentRoot()
      : preview;
  const previewCard = preview.closest(".preview-card");
  const previewHeader = previewCard.querySelector(".head");
  const previewStage = document.createElement("div");
  previewStage.className = "preview-stage";
  const previewDeviceShell = document.createElement("div");
  previewDeviceShell.className = "preview-device-shell";
  preview.before(previewStage);
  previewStage.append(previewDeviceShell);
  previewDeviceShell.append(preview);
  const devicePresets = {
    "iphone-16": { label: "iPhone 16", width: 393, height: 852 },
    "iphone-16-plus": { label: "iPhone 16 Plus", width: 430, height: 932 },
    "iphone-16-pro": { label: "iPhone 16 Pro", width: 402, height: 874 },
    "iphone-16-pro-max": {
      label: "iPhone 16 Pro Max",
      width: 440,
      height: 956,
    },
    "iphone-17": { label: "iPhone 17", width: 393, height: 852 },
    "iphone-17-air": { label: "iPhone 17 Air", width: 430, height: 932 },
    "iphone-17-pro": { label: "iPhone 17 Pro", width: 402, height: 874 },
    "iphone-17-pro-max": {
      label: "iPhone 17 Pro Max",
      width: 440,
      height: 956,
    },
    "iphone-18": { label: "iPhone 18", width: 393, height: 852 },
    "iphone-18-pro": { label: "iPhone 18 Pro", width: 402, height: 874 },
    "iphone-18-pro-max": {
      label: "iPhone 18 Pro Max",
      width: 440,
      height: 956,
    },
    "ipad-mini": { label: "iPad mini", width: 744, height: 1133 },
    ipad: { label: "iPad", width: 820, height: 1180 },
    "ipad-air": { label: "iPad Air", width: 820, height: 1180 },
    "ipad-pro-11": { label: "iPad Pro 11″", width: 834, height: 1194 },
    "ipad-pro-13": { label: "iPad Pro 13″", width: 1032, height: 1376 },
  };
  previewHeader.innerHTML = `<span>미리보기</span><div class="device-controls"><select id="phonePreview" aria-label="아이폰 미리보기"><option value="">아이폰</option><option value="iphone-16">iPhone 16</option><option value="iphone-16-plus">16 Plus</option><option value="iphone-16-pro">16 Pro</option><option value="iphone-16-pro-max">16 Pro Max</option><option value="iphone-17">iPhone 17</option><option value="iphone-17-air">17 Air</option><option value="iphone-17-pro">17 Pro</option><option value="iphone-17-pro-max">17 Pro Max</option><option value="iphone-18">iPhone 18</option><option value="iphone-18-pro">18 Pro</option><option value="iphone-18-pro-max">18 Pro Max</option></select><select id="tabletPreview" aria-label="태블릿 미리보기"><option value="">Tablet</option><option value="ipad-mini">iPad mini</option><option value="ipad">iPad</option><option value="ipad-air">iPad Air</option><option value="ipad-pro-11">iPad Pro 11″</option><option value="ipad-pro-13">iPad Pro 13″</option></select><span class="tablet-scale-controls" hidden><button type="button" data-tablet-scale="fit" aria-pressed="true">맞춤</button><button type="button" data-tablet-scale="actual" aria-pressed="false">100%</button></span></div>`;
  const phonePreview = previewHeader.querySelector("#phonePreview");
  const tabletPreview = previewHeader.querySelector("#tabletPreview");
  const tabletScaleControls = previewHeader.querySelector('.tablet-scale-controls');
  let selectedDevice = "";
  let tabletScaleMode = 'fit';
  const applyDevicePreview = () => {
    const device = devicePresets[selectedDevice];
    const isTablet = selectedDevice.startsWith('ipad');
    tabletScaleControls.hidden = !isTablet;
    tabletScaleControls.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.tabletScale === tabletScaleMode)));
    previewStage.dataset.tabletActual = String(isTablet && tabletScaleMode === 'actual');
    if (!device) {
      preview.dataset.devicePreview = "false";
      previewDeviceShell.dataset.devicePreview = "false";
      preview.style.removeProperty("width");
      preview.style.removeProperty("height");
      preview.style.removeProperty("aspect-ratio");
      preview.style.removeProperty("transform");
      previewDeviceShell.style.removeProperty("width");
      previewDeviceShell.style.removeProperty("height");
      return;
    }
    // Keep the iframe at the device's CSS viewport. Only its presentation is
    // scaled; feeding a physical, scaled width into the iframe changes CSS
    // breakpoints and produces an inaccurate device preview.
    const availableWidth = Math.max(1, previewStage.clientWidth);
    const availableHeight = Math.max(1, previewStage.clientHeight);
    const fitScale = Math.max(
      0.1,
      Math.min(
        1,
        availableWidth / (device.width + 16),
        availableHeight / (device.height + 16),
      ),
    );
    const scale = isTablet && tabletScaleMode === 'actual' ? 1 : fitScale;
    preview.dataset.devicePreview = "true";
    previewDeviceShell.dataset.devicePreview = "true";
    preview.style.setProperty("width", `${device.width}px`, "important");
    preview.style.setProperty("height", `${device.height}px`, "important");
    preview.style.setProperty("transform", `scale(${scale})`);
    previewDeviceShell.style.width = `${Math.round((device.width + 16) * scale)}px`;
    previewDeviceShell.style.height = `${Math.round((device.height + 16) * scale)}px`;
  };
  phonePreview.addEventListener("change", () => {
    selectedDevice = phonePreview.value;
    if (selectedDevice) tabletPreview.value = "";
    applyDevicePreview();
  });
  tabletPreview.addEventListener("change", () => {
    selectedDevice = tabletPreview.value;
    if (selectedDevice) phonePreview.value = "";
    applyDevicePreview();
  });
  tabletScaleControls.addEventListener('click',event => {
    const button = event.target.closest('button[data-tablet-scale]');
    if (!button) return;
    tabletScaleMode = button.dataset.tabletScale;
    applyDevicePreview();
  });
  new ResizeObserver(applyDevicePreview).observe(previewCard);
  new ResizeObserver(applyDevicePreview).observe(previewStage);

  return {
    previewCard,
    previewContentRoot,
    previewScrollRoot,
    setPreviewIframe: (frame) => {
      previewIframe = frame;
    },
  };
}

export function mountPreviewSync({
  previewUi,
  preview,
  htmlEditor,
  cssEditor,
  visualEditor,
  bookProject,
  isCoverSelected,
  showCoverPreview,
  snapshotCurrentChapter,
  hydrateResourceImages,
  activeChapterIndex,
  getVisualLoadedChapterId,
  getTiptapEditor,
  followBookLink,
}) {
  const { previewContentRoot, previewScrollRoot } = previewUi;
  const refreshPreview = () => {
    cancelAnimationFrame(previewFrame);
    // 표지 선택은 chapter selection을 바꾸지 않는 읽기 전용 view다. 이 상태에서
    // editor input/저장 이벤트가 오더라도 마지막 본문을 다시 그려 표지를 덮지 않는다.
    if (isCoverSelected()) {
      showCoverPreview();
      return;
    }
    snapshotCurrentChapter();
    // Preview-only sanitisation: the editor and EPUB exporter retain the
    // original XHTML verbatim, while imported content cannot execute in this
    // app's document.
    const content = document.createElement("template");
    content.innerHTML = DOMPurify.sanitize(htmlEditor.value, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      ADD_ATTR: ["epub:type", "xml:lang", "data-sitescout-footnote"],
    });
    const scrollTop = previewScrollRoot().scrollTop;
    const chapterId = bookProject.selectedChapterId;
    const frame = document.createElement("iframe");
    frame.className = "preview-isolated-frame";
    frame.title = "격리된 EPUB 미리보기";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener(
      "load",
      () => {
        if (!frame.isConnected || chapterId !== bookProject.selectedChapterId)
          return;
        const doc = frame.contentDocument;
        if (!doc) return;
        const colors = getComputedStyle(preview);
        doc.documentElement.style.color = colors.color;
        doc.documentElement.style.backgroundColor = colors.backgroundColor;
        const style = doc.createElement("style");
        style.textContent = cssEditor.value;
        doc.head.append(style);
        doc.body.style.setProperty("font-size", "20px", "important");
        const scrollbarStyle = doc.createElement("style");
        scrollbarStyle.textContent =
          "html,body{scrollbar-width:none!important;-ms-overflow-style:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
        doc.head.append(scrollbarStyle);
        hydrateResourceImages(doc.body, activeChapterIndex());
        (doc.scrollingElement || doc.body).scrollTop = scrollTop;
        doc.addEventListener("click", handlePreviewClick);
      },
      { once: true },
    );
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;font:20px/1.6 sans-serif;color:inherit}body{padding:18px;box-sizing:border-box;overflow:auto}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:5px}.preview-focus{background:rgba(240,142,49,.16);outline:2px solid #e88a31}mark.preview-context{background:rgba(240,142,49,.32);color:inherit;border-radius:2px;padding:0 1px}</style></head><body>${content.innerHTML}</body></html>`;
    previewUi.setPreviewIframe(frame);
    preview.replaceChildren(frame);
  };
  let previewFrame = 0;
  const schedulePreview = () => {
    cancelAnimationFrame(previewFrame);
    const chapterId = bookProject.selectedChapterId;
    previewFrame = requestAnimationFrame(() => {
      if (chapterId === bookProject.selectedChapterId) refreshPreview();
    });
  };
  cssEditor.addEventListener("input", schedulePreview);
  const previewBlockSelector =
    "p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,img,hr,br";
  let focusSyncing = false;
  const sourceNodeForElement = (element, rootNode) => {
    if (!element || !rootNode.contains(element)) return null;
    const nodes = sourceElements(htmlEditor.value);
    if (element.id) {
      const match = nodes.find(
        (node) => sourceAttribute(node, "id") === element.id,
      );
      if (match) return match;
    }
    const tag = element.tagName?.toLowerCase();
    const occurrence = Array.from(rootNode.querySelectorAll(tag)).indexOf(
      element,
    );
    return nodes.filter((node) => node.tag === tag)[occurrence] || null;
  };
  const renderedElementForSource = (node, rootNode) => {
    if (!node) return null;
    const id = sourceAttribute(node, "id");
    if (id) {
      const exact = Array.from(rootNode.querySelectorAll("[id]")).find(
        (element) => element.id === id,
      );
      if (exact) return exact;
    }
    const direct = elementAtPath(rootNode, node.path);
    if (direct?.tagName.toLowerCase() === node.tag) return direct;
    const peers = sourceElements(htmlEditor.value).filter(
      (item) => item.tag === node.tag,
    );
    const ordinal = peers.findIndex((item) => item.start === node.start);
    return Array.from(rootNode.querySelectorAll(node.tag))[ordinal] || null;
  };
  const scrollWithin = (panel, target) => {
    if (!target || panel.hidden) return;
    const bounds = target.getBoundingClientRect();
    // The iframe scrollingElement's bounding box spans its whole document,
    // not the visible iframe viewport. Use the inner viewport for that root.
    const frame = panel === panel.ownerDocument.scrollingElement
      ? {top:0,bottom:panel.ownerDocument.defaultView.innerHeight,height:panel.ownerDocument.defaultView.innerHeight}
      : panel.getBoundingClientRect();
    if (bounds.top < frame.top || bounds.bottom > frame.bottom)
      panel.scrollTop += bounds.top - frame.top - frame.height / 3;
  };
  const previewTextOffset = (element, container, offset) => {
    if (!element || !container || !element.contains(container)) return 0;
    try {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.setEnd(container, offset);
      return range.toString().length;
    } catch {
      return 0;
    }
  };
  const sourceTextOffset = (node, offset) => {
    if (!node || !Number.isInteger(offset)) return 0;
    const source = htmlEditor.value.slice(
      node.start,
      Math.max(node.start, offset),
    );
    const contentStart = source.indexOf(">");
    if (contentStart < 0) return 0;
    return new DOMParser().parseFromString(
      `<body>${source.slice(contentStart + 1)}</body>`,
      "text/html",
    ).body.textContent.length;
  };
  const sourcePositionAtText = (node, textOffset) => {
    const source = htmlEditor.value;
    let position = source.indexOf('>',node.start) + 1;
    if (!position || position > node.end) return node.start;
    let seen = 0;
    while (position < node.end) {
      const char = source[position];
      if (char === '<') {
        let close = position + 1, quote = '';
        for (; close < node.end; close++) {
          if (quote) { if (source[close] === quote) quote = ''; }
          else if (source[close] === '"' || source[close] === "'") quote = source[close];
          else if (source[close] === '>') break;
        }
        if (close >= node.end) break;
        position = close + 1;
        continue;
      }
      if (seen >= textOffset) return position;
      if (char === '&') {
        const end = source.indexOf(';',position + 1);
        if (end > position && end < node.end) {
          const decoded = new DOMParser().parseFromString(`<span>${source.slice(position,end + 1)}</span>`,'text/html').body.textContent;
          seen += decoded.length;
          position = end + 1;
          continue;
        }
      }
      seen++;
      position++;
    }
    return Math.min(position,node.end);
  };
  const textPositionAtOffset = (element, textOffset) => {
    const walker = element.ownerDocument.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    let node;
    let remaining = textOffset;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) return {node,offset:remaining};
      remaining -= node.data.length;
    }
    return null;
  };
  const highlightPreviewContext = (element, caretOffset = 0) => {
    const rootNode = previewContentRoot();
    rootNode
      .querySelectorAll("mark.preview-context")
      .forEach((mark) => mark.replaceWith(...mark.childNodes));
    if (!element) return;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const words = [];
    let node;
    let base = 0;
    while ((node = walker.nextNode())) {
      for (const match of node.data.matchAll(/\S+/g))
        words.push({
          node,
          start: base + match.index,
          end: base + match.index + match[0].length,
          localStart: match.index,
          localEnd: match.index + match[0].length,
        });
      base += node.data.length;
    }
    const index = words.findIndex(
      (word) => caretOffset >= word.start && caretOffset <= word.end,
    );
    const selected = (
      index >= 0
        ? [words[Math.max(0, index - 1)], words[index], words[index + 1]]
        : words.slice(0, 2)
    ).filter(Boolean);
    // Wrap from the end so offsets in preceding text nodes stay stable.
    for (const word of [...new Set(selected)].sort(
      (left, right) => right.start - left.start,
    )) {
      const range = rootNode.ownerDocument.createRange();
      range.setStart(word.node, word.localStart);
      range.setEnd(word.node, word.localEnd);
      const mark = rootNode.ownerDocument.createElement("mark");
      mark.className = "preview-context";
      try {
        range.surroundContents(mark);
      } catch {
        /* inline boundary: keep the block highlight */
      }
    }
  };
  const synchronizeFocus = (node, origin, caretOffset = 0) => {
    if (!node || focusSyncing || isCoverSelected()) return;
    const chapterId = bookProject.selectedChapterId;
    focusSyncing = true;
    try {
      const previewRoot = previewContentRoot();
      const previewElement = renderedElementForSource(node, previewRoot);
      if (previewElement) {
        previewRoot
          .querySelectorAll(".preview-focus")
          .forEach((element) => element.classList.remove("preview-focus"));
        previewElement.classList.add("preview-focus");
        highlightPreviewContext(previewElement, caretOffset);
        if (origin !== "preview")
          scrollWithin(previewScrollRoot(), previewElement);
      }
      const visualRoot =
        visualEditor.querySelector(".ProseMirror") || visualEditor;
      const visualElement = renderedElementForSource(node, visualRoot);
      if (
        visualElement &&
        origin !== "visual" &&
        getVisualLoadedChapterId() === chapterId
      ) {
        if (getTiptapEditor()) {
          try {
            const point = textPositionAtOffset(visualElement,caretOffset);
            getTiptapEditor().commands.setTextSelection(
              point ? getTiptapEditor().view.posAtDOM(point.node,point.offset)
                : getTiptapEditor().view.posAtDOM(visualElement,0),
            );
          } catch {
            /* unsupported node: keep current caret */
          }
        }
        scrollWithin(visualEditor, visualElement);
      }
      const editor = window.epubMonacoEditor;
      if (
        editor &&
        origin !== "monaco" &&
        editor.getValue() === htmlEditor.value
      ) {
        const position = editor.getModel().getPositionAt(sourcePositionAtText(node,caretOffset));
        editor.setPosition(position);
        editor.revealPositionInCenterIfOutsideViewport(position);
      }
    } finally {
      focusSyncing = false;
    }
  };
  const handlePreviewClick = (event) => {
    const anchor = event.target.closest("a[href]");
    if (anchor && followBookLink(anchor)) {
      event.preventDefault();
      return;
    }
    const rootNode = previewContentRoot();
    const target = event.target.closest(previewBlockSelector);
    const doc = event.target.ownerDocument;
    const caret = doc.caretPositionFromPoint?.(event.clientX,event.clientY);
    const range = !caret ? doc.caretRangeFromPoint?.(event.clientX,event.clientY) : null;
    const textNode = caret?.offsetNode || range?.startContainer;
    const textOffset = caret?.offset ?? range?.startOffset ?? 0;
    synchronizeFocus(
      sourceNodeForElement(target, rootNode),
      "preview",
      previewTextOffset(target,textNode,textOffset),
    );
  };
  preview.addEventListener("click", handlePreviewClick);
  visualEditor.addEventListener("click", (event) => {
    const anchor = event.target.closest("a[href]");
    if (anchor && followBookLink(anchor)) {
      event.preventDefault();
      return;
    }
    const target = event.target.closest(
      previewBlockSelector + ",a,span,strong,em",
    );
    const selection = window.getSelection();
    synchronizeFocus(
      sourceNodeForElement(target, visualEditor),
      "visual",
      previewTextOffset(
        target,
        selection?.anchorNode,
        selection?.anchorOffset || 0,
      ),
    );
  });
  visualEditor.addEventListener("keyup", () => {
    const selection = window.getSelection();
    const element =
      selection?.anchorNode?.nodeType === 1
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;
    synchronizeFocus(
      sourceNodeForElement(element, visualEditor),
      "visual",
      previewTextOffset(
        element,
        selection?.anchorNode,
        selection?.anchorOffset || 0,
      ),
    );
  });
  return {
    refreshPreview,
    schedulePreview,
    synchronizeFocus,
    sourceNodeForElement,
    previewBlockSelector,
    previewTextOffset,
    sourceTextOffset,
    isFocusSyncing: () => focusSyncing,
  };
}
