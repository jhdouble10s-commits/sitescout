// EPUB export gateway for imported and new books. ui.js supplies the current snapshot and user feedback.
// Preserve XHTML, assets, cover, manifest/spine, nested TOC, and footnotes; test actual exported ZIPs after edits.
import { imageAssetPath, resolveImagePath } from "./image-references.js";

export function createEpubExporter(ctx) {
  const {
    collectDraft,
    previewAssets,
    validateAllChapters,
    setStatus,
    prepareFootnotes,
    normaliseXhtml,
    defaultChapterFileName,
    epubText,
    epubEscape,
    createEpubZip,
    normaliseImportedFootnoteLinks,
    replaceXhtmlBody,
    replaceXhtmlTitle,
    relativeEpubPath,
    importedMetadata,
    zipText,
    makeEpubNav,
  } = ctx;
  const exportImportedEpub3 = async (draft) => {
    const imported = ctx.importedEpub;
    if (!imported) return false;
    const output = new Map(imported.files);
    const addedMeta = [];
    const resolvedMeta = new Map(
      draft.chapters.map((chapter) => {
        let meta = imported.chapterMeta.find(
          (item) => item.path === chapter.originalPath,
        );
        if (!meta) {
          const path = `${imported.packageBase}text/${chapter.fileName}`;
          if (output.has(path) && path !== imported.footnotePath)
            throw new Error(`새 장 경로가 기존 리소스와 겹칩니다: ${path}`);
          meta = {
            path,
            idref: chapter.id,
            body: "",
            tocTitle: chapter.title,
            source: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${epubEscape(chapter.title)}</title></head><body></body></html>`,
          };
          addedMeta.push(meta);
        }
        return [chapter.id, meta];
      }),
    );
    let replacementCoverType = "";
    if (
      imported.coverReplaced &&
      imported.coverImagePath &&
      draft.coverSource
    ) {
      const blob = await fetch(draft.coverSource).then((response) =>
        response.blob(),
      );
      output.set(
        imported.coverImagePath,
        new Uint8Array(await blob.arrayBuffer()),
      );
      replacementCoverType = blob.type || "";
    }
    const metaForChapter = (chapter) => resolvedMeta.get(chapter.id);
    draft.chapters.forEach((chapter, index) => {
      const meta = metaForChapter(chapter, index);
      const exportBody = normaliseImportedFootnoteLinks(
        chapter.body.replace(
          /\sdata-sitescout-footnote\s*=\s*(["']).*?\1/gi,
          "",
        ),
        meta.path,
        imported.footnotePath,
      );
      let source =
        chapter.body === meta.body
          ? meta.source
          : replaceXhtmlBody(meta.source, exportBody);
      if (chapter.title && chapter.title !== meta.tocTitle)
        source = replaceXhtmlTitle(source, chapter.title);
      output.set(meta.path, epubText(source));
    });
    if (imported.stylesheetPath && output.has(imported.stylesheetPath))
      output.set(imported.stylesheetPath, epubText(draft.css));
    // 원본 EPUB에 없던 새 각주만 기존 각주 문서 끝에 추가한다. 기존 footnote
    // 마크업과 내부 링크는 삭제하거나 재작성하지 않는다.
    const footnotePath =
      imported.footnotePath || `${imported.packageBase}text/footnote.xhtml`;
    const generatedFootnoteId = "sitescout-footnotes";
    if (draft.footnotes?.length) {
      const asides = draft.footnotes
        .map((note) => {
          const sourceIndex = draft.chapters.findIndex(
            (chapter) => chapter.id === note.sourceChapterId,
          );
          const source = metaForChapter(
            draft.chapters[Math.max(0, sourceIndex)],
            Math.max(0, sourceIndex),
          );
          const href = relativeEpubPath(footnotePath, source.path);
          return `<aside epub:type="footnote" id="${epubEscape(note.id)}"><p><a href="${epubEscape(href)}#${epubEscape(note.referenceId)}">${note.number}.</a> ${note.content}</p></aside>`;
        })
        .join("");
      if (output.has(footnotePath)) {
        const original = zipText(output.get(footnotePath));
        const addition = `<section id="${generatedFootnoteId}" epub:type="footnotes">${asides}</section>`;
        output.set(
          footnotePath,
          epubText(
            /<\/body\s*>/i.test(original)
              ? original.replace(/<\/body\s*>/i, `${addition}</body>`)
              : `${original}${addition}`,
          ),
        );
      } else {
        output.set(
          footnotePath,
          epubText(
            `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${epubEscape(draft.language || "ko")}"><head><title>각주</title></head><body><section id="${generatedFootnoteId}" epub:type="footnotes"><h1>각주</h1>${asides}</section></body></html>`,
          ),
        );
      }
    }
    const draftTocExcluded = new Set(draft.tocExcluded);
    const draftParentTocMap = new Map(draft.parentToc);
    const navItems = draft.chapters
      .map((chapter, index) => ({
        meta: metaForChapter(chapter, index),
        index,
        chapter,
      }))
      .filter(({ index }) => !draftTocExcluded.has(index));
    const renderNav = (parent) =>
      navItems
        .filter(
          ({ index }) => (draftParentTocMap.get(index) ?? null) === parent,
        )
        .map(({ meta, index, chapter }) => {
          const children = renderNav(index);
          const href = relativeEpubPath(imported.navPath, meta.path);
          return `<li><a href="${epubEscape(href)}">${epubEscape(chapter.title || meta.tocTitle || "제목 없는 장")}</a>${children ? `<ol>${children}</ol>` : ""}</li>`;
        })
        .join("");
    let navMarkup = renderNav(null);
    let currentTocTree = null;
    if (imported.tocTree?.length) {
      const originalChapterPaths = new Set(
        imported.chapterMeta.map((meta) => meta.path),
      );
      const currentPaths = new Set(
        draft.chapters.map((chapter) => chapter.originalPath),
      );
      const includedPaths = new Set(
        navItems.map((item) => item.chapter.originalPath),
      );
      const coveredPaths = new Set();
      const copyTree = (nodes) => nodes.map(node => ({...node,children:copyTree(node.children || [])}));
      currentTocTree = copyTree(imported.tocTree);
      const originalTocSignature = JSON.stringify(currentTocTree);
      const primaryByPath = new Map();
      const parentByNode = new Map();
      const indexTree = (nodes,parent = null) => nodes.forEach(node => {
        if (node.path && !primaryByPath.has(node.path)) primaryByPath.set(node.path,node);
        parentByNode.set(node,parent);
        indexTree(node.children,node);
      });
      indexTree(currentTocTree);
      // A chapter owns its first imported TOC entry. Other same-file anchors
      // stay in that entry's subtree with their original fragment and label.
      navItems.forEach(({chapter,meta}) => {
        const node = primaryByPath.get(chapter.originalPath);
        if (node && chapter.title && chapter.title !== meta.tocTitle) node.title = chapter.title;
      });
      navItems.forEach(({index,chapter,meta}) => {
        if (primaryByPath.has(chapter.originalPath)) return;
        const node = {path:meta.path,fragment:'',title:chapter.title || meta.tocTitle || '제목 없는 장',children:[]};
        currentTocTree.push(node); primaryByPath.set(chapter.originalPath,node); parentByNode.set(node,null);
      });
      navItems.forEach(({index,chapter}) => {
        const node = primaryByPath.get(chapter.originalPath);
        const parentChapter = draft.chapters[draftParentTocMap.get(index)];
        const originalParentPath = imported.chapterMeta.find(meta => meta.path === chapter.originalPath)?.tocParentPath || null;
        if ((parentChapter?.originalPath || null) === originalParentPath) return;
        const nextParent = parentChapter ? primaryByPath.get(parentChapter.originalPath) || null : null;
        if (!node || node === nextParent || parentByNode.get(node) === nextParent) return;
        let ancestor = nextParent;
        while (ancestor) { if (ancestor === node) return; ancestor = parentByNode.get(ancestor); }
        const oldParent = parentByNode.get(node);
        const siblings = oldParent ? oldParent.children : currentTocTree;
        siblings.splice(siblings.indexOf(node),1);
        (nextParent ? nextParent.children : currentTocTree).push(node);
        parentByNode.set(node,nextParent);
      });
      const includeNode = (node) => {
        if (originalChapterPaths.has(node.path) && !currentPaths.has(node.path) && !imported.coverPagePaths.includes(node.path)) return false;
        if (imported.coverDeleted && imported.coverPagePaths.includes(node.path)) return false;
        if (currentPaths.has(node.path) && !includedPaths.has(node.path)) return false;
        return true;
      };
      const renderTree = (nodes) =>
        nodes
          .map((node) => {
            if (!includeNode(node)) return '';
            const chapter = navItems.find(
              (item) => item.chapter.originalPath === node.path || item.meta.path === node.path,
            );
            const path = chapter?.meta.path || node.path;
            if (chapter) coveredPaths.add(chapter.meta.path);
            const href = `${relativeEpubPath(imported.navPath, path)}${node.fragment || ""}`;
            const children = renderTree(node.children || []);
            return `<li>${path ? `<a href="${epubEscape(href)}">${epubEscape(node.title || chapter?.chapter.title || "제목 없는 장")}</a>` : `<span>${epubEscape(node.title)}</span>`}${children ? `<ol>${children}</ol>` : ""}</li>`;
          })
          .join("");
      navMarkup =
        renderTree(currentTocTree) +
        navItems
          .filter((item) => !coveredPaths.has(item.meta.path))
          .map(
            (item) =>
              `<li><a href="${epubEscape(relativeEpubPath(imported.navPath, item.meta.path))}">${epubEscape(item.chapter.title || "제목 없는 장")}</a></li>`,
          )
          .join("");
      const ncxItem = imported.manifest.find(item => item.type === 'application/x-dtbncx+xml' && output.has(item.href));
      const originallyIncluded = new Set(imported.chapterMeta.filter(meta => meta.includeInToc).map(meta => meta.path));
      const inclusionChanged = originallyIncluded.size !== includedPaths.size
        || [...originallyIncluded].some(path => !includedPaths.has(path));
      if (ncxItem && (originalTocSignature !== JSON.stringify(currentTocTree) || inclusionChanged || imported.coverDeleted)) {
        const documentNode = new DOMParser().parseFromString(zipText(output.get(ncxItem.href)),'application/xml');
        const navMap = documentNode.getElementsByTagNameNS('*','navMap')[0];
        if (!navMap || documentNode.getElementsByTagName('parsererror').length) throw new Error('원본 NCX 목차를 읽을 수 없습니다.');
        const originalIds = new Map(Array.from(navMap.getElementsByTagNameNS('*','navPoint')).map(point => [
          point.getElementsByTagNameNS('*','content')[0]?.getAttribute('src'),point.getAttribute('id')
        ]));
        Array.from(navMap.children).filter(child => child.localName === 'navPoint').forEach(child => child.remove());
        const namespace = navMap.namespaceURI || 'http://www.daisy.org/z3986/2005/ncx/';
        let playOrder = 0;
        let generatedId = 0;
        const usedIds = new Set();
        const appendNcx = (nodes,parent) => nodes.forEach(node => {
          if (!includeNode(node)) return;
          if (!node.path) { appendNcx(node.children || [],parent); return; }
          const point = documentNode.createElementNS(namespace,'navPoint');
          const href = `${relativeEpubPath(ncxItem.href,node.path)}${node.fragment || ''}`;
          const oldId = originalIds.get(href);
          let id = oldId && !usedIds.has(oldId) ? oldId : `sitescout-nav-${++generatedId}`;
          while (usedIds.has(id)) id = `sitescout-nav-${++generatedId}`;
          usedIds.add(id);
          point.setAttribute('id',id);
          playOrder++;
          point.setAttribute('playOrder',String(playOrder));
          const label = documentNode.createElementNS(namespace,'navLabel');
          const text = documentNode.createElementNS(namespace,'text'); text.textContent = node.title || '제목 없는 장';
          label.append(text); point.append(label);
          const content = documentNode.createElementNS(namespace,'content');
          content.setAttribute('src',href);
          point.append(content); parent.append(point);
          appendNcx(node.children || [],point);
        });
        appendNcx(currentTocTree,navMap);
        output.set(ncxItem.href,epubText(new XMLSerializer().serializeToString(documentNode)));
      }
    }
    output.set(
      imported.navPath,
      epubText(
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><h1>목차</h1><ol>${navMarkup}</ol></nav></body></html>`,
      ),
    );
    const retainedPaths = new Set(
      draft.chapters.map((chapter) => metaForChapter(chapter).path),
    );
    const deletedPaths = new Set(
      imported.chapterMeta
        .filter((meta) => !retainedPaths.has(meta.path))
        .map((meta) => meta.path),
    );
    if (imported.coverDeleted)
      imported.coverPagePaths.forEach((path) => deletedPaths.add(path));
    deletedPaths.forEach((path) => output.delete(path));
    const manifest = imported.manifest
      .filter(
        (item) =>
          !deletedPaths.has(item.href) &&
          !item.properties.split(/\s+/).includes("nav"),
      )
      .map((item) => {
        const properties = new Set(
          item.properties.split(/\s+/).filter(Boolean),
        );
        if (item.href === imported.coverImagePath && !imported.coverDeleted)
          properties.add("cover-image");
        if (imported.coverDeleted) properties.delete("cover-image");
        const mediaType =
          item.href === imported.coverImagePath && replacementCoverType
            ? replacementCoverType
            : item.type;
        return `<item id="${epubEscape(item.id)}" href="${epubEscape(item.rawHref)}" media-type="${epubEscape(mediaType)}"${properties.size ? ` properties="${epubEscape(Array.from(properties).join(" "))}"` : ""}/>`;
      });
    addedMeta.forEach((meta) =>
      manifest.push(
        `<item id="${epubEscape(meta.idref)}" href="${epubEscape(relativeEpubPath(imported.packagePath, meta.path))}" media-type="application/xhtml+xml"/>`,
      ),
    );
    const hasFootnoteManifest = imported.manifest.some(
      (item) => item.href === footnotePath,
    );
    if (draft.footnotes?.length && !hasFootnoteManifest)
      manifest.push(
        `<item id="footnotes" href="${epubEscape(relativeEpubPath(imported.packagePath, footnotePath))}" media-type="application/xhtml+xml"/>`,
      );
    const navHref = relativeEpubPath(imported.packagePath, imported.navPath);
    manifest.push(
      `<item id="nav" href="${epubEscape(navHref)}" media-type="application/xhtml+xml" properties="nav"/>`,
    );
    const orderedRefs = draft.chapters.map(
      (chapter) =>
        imported.spineRefs.find(
          (ref) => ref.idref === metaForChapter(chapter).idref,
        ) || { idref: metaForChapter(chapter).idref },
    );
    const chapterRefIds = new Set(
      imported.chapterMeta.map((meta) => meta.idref),
    );
    let chapterRefIndex = 0;
    const spineRefs = imported.spineRefs
      .filter(
        (ref) =>
          !deletedPaths.has(
            imported.manifest.find((item) => item.id === ref.idref)?.href,
          ) || chapterRefIds.has(ref.idref),
      )
      .flatMap((ref) => {
        const next = chapterRefIds.has(ref.idref)
          ? orderedRefs[chapterRefIndex++]
          : ref;
        return next ? [{ ...next }] : [];
      });
    spineRefs.push(...orderedRefs.slice(chapterRefIndex));
    if (
      draft.footnotes?.length &&
      !spineRefs.some(
        (ref) => ref.idref === (imported.footnoteManifestId || "footnotes"),
      )
    )
      spineRefs.push({ idref: "footnotes", linear: "no" });
    const spine = spineRefs
      .map(
        (ref) =>
          `<itemref idref="${epubEscape(ref.idref)}"${ref.linear ? ` linear="${epubEscape(ref.linear)}"` : ""}/>`,
      )
      .join("");
    const title = draft.title || "새 전자책";
    const language = draft.language || "ko";
    output.set(
      imported.packagePath,
      epubText(
        `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${epubEscape(language)}">${importedMetadata(imported, draft)}<manifest>${manifest.join("")}</manifest><spine>${spine}</spine></package>`,
      ),
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      await createEpubZip(
        Array.from(output, ([name, data]) => ({ name, data })),
      ),
    );
    link.download = `${title.replace(/[\\/:*?"<>|]/g, "-")}.epub`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    setStatus(
      `[${title}] EPUB 3.0 파일을 다운로드했습니다. 원본 spine·경로·목차를 보존했습니다.`,
    );
    return true;
  };
  const exportAssetAwareEpub = async () => {
    const draft = collectDraft();
    if (ctx.importedEpub?.sourceMissing?.length) {
      setStatus(`원본 EPUB 리소스 ${ctx.importedEpub.sourceMissing.length}개를 불러오지 못해 내보낼 수 없습니다. 프로젝트를 다시 열어 주세요.`, 'error');
      return false;
    }
    const missing = draft.assets.filter(
      (asset) => !previewAssets.get(asset.name)?.blob,
    );
    if (missing.length) {
      setStatus(
        `이미지 ${missing.length}개를 불러오지 못해 EPUB을 내보낼 수 없습니다. 이미지 다시 불러오기를 사용하세요.`,
        "error",
      );
      return false;
    }
    // This is the single export gateway: imported and newly-created EPUBs
    // both stop here before a ZIP Blob or download link can be made.
    const xhtmlErrors = validateAllChapters(draft);
    if (xhtmlErrors.length) {
      setStatus(
        `XHTML 오류 ${xhtmlErrors.length}건이 있어 EPUB을 내보낼 수 없습니다. 오류를 수정한 뒤 다시 시도하세요.`,
        "error",
      );
      return false;
    }
    const availableImages = new Set(
      draft.assets.map((asset) => imageAssetPath(asset.name, asset)),
    );
    const missingReferences = [];
    for (const chapter of draft.chapters) {
      const base = chapter.originalPath || `EPUB/text/${chapter.fileName}`;
      const bodyDocument = new DOMParser().parseFromString(
        `<root xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">${chapter.body}</root>`,
        "application/xml",
      );
      for (const image of [
        ...bodyDocument.getElementsByTagName("img"),
        ...bodyDocument.getElementsByTagNameNS(
          "http://www.w3.org/2000/svg",
          "image",
        ),
      ]) {
        const source =
          image.getAttribute("src") ||
          image.getAttribute("href") ||
          image.getAttribute("xlink:href");
        const path = source?.startsWith("images/")
          ? `EPUB/Image/${source.slice(7).split(/[?#]/)[0]}`
          : resolveImagePath(source, base);
        if (path && !availableImages.has(path)) missingReferences.push(path);
      }
    }
    for (const item of ctx.importedEpub?.manifest || []) {
      if (
        item.type.startsWith("image/") &&
        !ctx.importedEpub.files.has(item.href) &&
        !availableImages.has(item.href)
      )
        missingReferences.push(item.href);
    }
    if (missingReferences.length) {
      setStatus(
        `참조된 이미지 ${[...new Set(missingReferences)].join(", ")}을(를) 찾지 못해 EPUB을 내보낼 수 없습니다.`,
        "error",
      );
      return false;
    }
    const footnoteResult = prepareFootnotes(draft);
    if (footnoteResult.errors.length) {
      setStatus(
        `각주 오류 ${footnoteResult.errors.length}건이 있어 EPUB을 내보낼 수 없습니다. 각주 링크와 내용을 확인하세요.`,
        "error",
      );
      return false;
    }
    draft.footnotes = footnoteResult.notes.map((note) => ({ ...note }));
    // UI-only cover/central-note entries have a single exporter below.
    // Persist all entries; only project the content spine for EPUB generation.
    draft.auxiliaryChapters = draft.chapters.filter(
      (chapter) =>
        chapter.generated && ["cover", "footnotes"].includes(chapter.type),
    );
    const kept = draft.chapters
      .map((chapter, index) => ({ chapter, index }))
      .filter(({ chapter }) => !draft.auxiliaryChapters.includes(chapter));
    const remap = new Map(kept.map(({ index }, next) => [index, next]));
    draft.tocExcluded = draft.tocExcluded
      .filter((index) => remap.has(index))
      .map((index) => remap.get(index));
    draft.parentToc = draft.parentToc
      .filter(([child, parent]) => remap.has(child) && remap.has(parent))
      .map(([child, parent]) => [remap.get(child), remap.get(parent)]);
    draft.chapters = kept.map(({ chapter }) => chapter);
    draft.updatedAt = new Date().toISOString();
    if (await exportImportedEpub3(draft)) return;
    const title = draft.title || "새 전자책";
    const language = draft.language || "ko";
    const files = [
      { name: "mimetype", data: epubText("application/epub+zip") },
      {
        name: "META-INF/container.xml",
        data: epubText(
          '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
      },
      { name: "EPUB/styles/book.css", data: epubText(draft.css) },
    ];
    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="css" href="styles/book.css" media-type="text/css"/>',
    ];
    const spine = [];
    const usedFilenames = new Set();
    const filenames = draft.chapters.map((chapter, index) => {
      const requested =
        String(chapter.fileName || defaultChapterFileName(index))
          .trim()
          .replace(/^.*[\\/]/, "")
          .replace(/[<>:"|?*]/g, "-") || defaultChapterFileName(index);
      const hasXhtmlExtension = /\.xhtml?$/i.test(requested);
      const extension = hasXhtmlExtension ? "" : ".xhtml";
      const base = hasXhtmlExtension
        ? requested
        : requested || `chapter-${index + 1}`;
      let filename = `${base}${extension}`;
      let suffix = 2;
      while (usedFilenames.has(filename.toLowerCase())) {
        filename = `${base}-${suffix}${extension}`;
        suffix += 1;
      }
      usedFilenames.add(filename.toLowerCase());
      return filename;
    });
    if (draft.coverSource) {
      const coverBlob = await fetch(draft.coverSource).then((response) =>
        response.blob(),
      );
      const coverExtension = coverBlob.type === "image/png" ? "png" : "jpg";
      const coverName = `cover.${coverExtension}`;
      files.push({
        name: `EPUB/Image/${coverName}`,
        data: new Uint8Array(await coverBlob.arrayBuffer()),
      });
      files.push({
        name: "EPUB/text/cover.xhtml",
        data: epubText(
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>표지</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head><body><img src="../Image/${coverName}" alt="표지"/></body></html>`,
        ),
      });
      manifest.push(
        `<item id="cover-image" href="Image/${coverName}" media-type="${coverBlob.type}" properties="cover-image"/>`,
        '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
      );
      spine.push('<itemref idref="cover-page" linear="no"/>');
    } else if (
      draft.auxiliaryChapters.some((chapter) => chapter.type === "cover")
    ) {
      files.push({
        name: "EPUB/text/cover.xhtml",
        data: epubText(
          '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>표지</title></head><body></body></html>',
        ),
      });
      manifest.push(
        '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
      );
      spine.push('<itemref idref="cover-page"/>');
    }
    for (let index = 0; index < draft.chapters.length; index += 1) {
      const chapter = draft.chapters[index];
      const filename = filenames[index];
      // data-sitescout-footnote는 편집기 내부 재정렬용 메타데이터다. 최종 EPUB에는
      // 표준 noteref 속성과 일반 href/id 링크만 남긴다.
      const body = normaliseXhtml(chapter.body)
        .replace(/\sdata-sitescout-footnote\s*=\s*(["']).*?\1/gi, "")
        .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/gi, "&amp;")
        .replace(/src=(['"])images\//g, "src=$1../Image/");
      files.push({
        name: `EPUB/text/${filename}`,
        data: epubText(
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${epubEscape(language)}"><head><meta charset="UTF-8"/><title>${epubEscape(chapter.title || title)}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head><body>${body}</body></html>`,
        ),
      });
      manifest.push(
        `<item id="chapter-${index + 1}" href="text/${filename}" media-type="application/xhtml+xml"/>`,
      );
      spine.push(`<itemref idref="chapter-${index + 1}"/>`);
    }
    if (
      draft.footnotes.length ||
      draft.auxiliaryChapters.some((chapter) => chapter.type === "footnotes")
    ) {
      const footnoteBody = draft.footnotes
        .map((note) => {
          const sourceIndex = draft.chapters.findIndex(
            (chapter) => chapter.id === note.sourceChapterId,
          );
          const sourceFile =
            filenames[Math.max(0, sourceIndex)] || filenames[0];
          return `<aside epub:type="footnote" id="${epubEscape(note.id)}"><p><a href="${epubEscape(sourceFile)}#${epubEscape(note.referenceId)}">${note.number}.</a> ${note.content}</p></aside>`;
        })
        .join("");
      files.push({
        name: "EPUB/text/footnote.xhtml",
        data: epubText(
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${epubEscape(language)}"><head><meta charset="UTF-8"/><title>각주</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head><body><section epub:type="footnotes"><h1>각주</h1>${footnoteBody}</section></body></html>`,
        ),
      });
      manifest.push(
        '<item id="footnotes" href="text/footnote.xhtml" media-type="application/xhtml+xml"/>',
      );
      spine.push('<itemref idref="footnotes" linear="no"/>');
    }
    for (let index = 0; index < draft.assets.length; index += 1) {
      const asset = draft.assets[index];
      const stored = previewAssets.get(asset.name);
      if (!stored?.blob) continue;
      files.push({
        name: `EPUB/Image/${asset.name}`,
        data: new Uint8Array(await stored.blob.arrayBuffer()),
      });
      manifest.push(
        `<item id="image-${index + 1}" href="Image/${epubEscape(asset.name)}" media-type="${epubEscape(asset.type || "image/png")}"/>`,
      );
    }
    const landmarks = [
      {
        name: "EPUB/text/cover.xhtml",
        type: "cover",
        href: "text/cover.xhtml",
        title: "표지",
      },
      {
        name: "EPUB/text/footnote.xhtml",
        type: "endnotes",
        href: "text/footnote.xhtml",
        title: "각주",
      },
    ].filter((item) => files.some((file) => file.name === item.name));
    files.push({
      name: "EPUB/nav.xhtml",
      data: epubText(
        makeEpubNav(draft.chapters, filenames, {
          tocExcluded: new Set(draft.tocExcluded),
          parentTocMap: new Map(draft.parentToc),
          landmarks,
        }),
      ),
    });
    files.push({
      name: "EPUB/package.opf",
      data: epubText(
        `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${epubEscape(language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${epubEscape(title)}</dc:title>${draft.author ? `<dc:creator>${epubEscape(draft.author)}</dc:creator>` : ""}<dc:language>${epubEscape(language)}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
      ),
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await createEpubZip(files));
    link.download = `${title.replace(/[\\/:*?"<>|]/g, "-")}.epub`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    setStatus(
      `[${title}] EPUB 3.0 파일을 다운로드했습니다. 다운로드 폴더를 확인하세요.`,
    );
  };
  return { exportAssetAwareEpub };
}
