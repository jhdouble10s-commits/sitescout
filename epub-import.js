// Read EPUB ZIP/OPF/spine/nav/NCX into import metadata without touching BookProject.
// ui.js checks the project revision before applying it; verify cover, nested TOC, paths, and source bytes after edits.
export async function parseEpubFile(
  file,
  {
    unzipEpub,
    xmlDocument,
    zipText,
    zipPath,
    elementText,
    xhtmlBody,
    xhtmlTitle,
    tocEntriesFromNav,
    tocEntriesFromNcx,
    createChapterId,
    defaultChapterFileName,
  },
) {
  const files = await unzipEpub(file);
  const container = xmlDocument(
    zipText(files.get("META-INF/container.xml") || new Uint8Array()),
    "container.xml",
  );
  const packagePath = container
    .getElementsByTagNameNS("*", "rootfile")[0]
    ?.getAttribute("full-path");
  if (!packagePath || !files.has(packagePath))
    throw new Error("EPUB 패키지(OPF)를 찾을 수 없습니다.");
  const packageDocument = xmlDocument(
    zipText(files.get(packagePath)),
    "EPUB 패키지",
  );
  const packageBase = packagePath.slice(0, packagePath.lastIndexOf("/") + 1);
  const metadataNode = packageDocument.getElementsByTagNameNS(
    "*",
    "metadata",
  )[0];
  const originalIdentifier = elementText(packageDocument, "identifier");
  const metadataExtras = Array.from(metadataNode?.children || [])
    .filter(
      (node) =>
        !["identifier", "title", "creator", "language"].includes(
          node.localName,
        ) &&
        !(
          node.localName === "meta" &&
          node.getAttribute("property") === "dcterms:modified"
        ),
    )
    .map((node) => new XMLSerializer().serializeToString(node))
    .join("");
  const manifest = new Map(
    Array.from(packageDocument.getElementsByTagNameNS("*", "item")).map(
      (item) => [
        item.getAttribute("id"),
        {
          id: item.getAttribute("id"),
          href: zipPath(packageBase, item.getAttribute("href") || ""),
          rawHref: item.getAttribute("href") || "",
          type: item.getAttribute("media-type") || "",
          properties: item.getAttribute("properties") || "",
        },
      ],
    ),
  );
  const spineRefs = Array.from(
    packageDocument.getElementsByTagNameNS("*", "itemref"),
  ).map((item) => ({
    idref: item.getAttribute("idref"),
    linear: item.getAttribute("linear") || "",
  }));
  const metadataCoverId = Array.from(
    packageDocument.getElementsByTagNameNS("*", "meta"),
  )
    .find((item) => item.getAttribute("name") === "cover")
    ?.getAttribute("content");
  const guideCoverRef =
    Array.from(packageDocument.getElementsByTagNameNS("*", "reference"))
      .find((item) => item.getAttribute("type") === "cover")
      ?.getAttribute("href") || "";
  const guideCoverPath = guideCoverRef
    ? zipPath(packageBase, guideCoverRef.split("#")[0])
    : "";
  let coverImage =
    Array.from(manifest.values()).find((item) =>
      item.properties.split(/\s+/).includes("cover-image"),
    ) || manifest.get(metadataCoverId);
  const coverPagePaths = new Set();
  if (guideCoverPath) {
    const guideItem = Array.from(manifest.values()).find(
      (item) => item.href === guideCoverPath,
    );
    if (guideItem?.type.includes("xhtml")) coverPagePaths.add(guideCoverPath);
    else if (guideItem?.type.startsWith("image/")) coverImage ||= guideItem;
  }
  const imageFromCoverPage = (path) => {
    const source = zipText(files.get(path) || new Uint8Array());
    const match = /(?:src|href|xlink:href)\s*=\s*(["'])(.*?)\1/i.exec(source);
    return match
      ? Array.from(manifest.values()).find(
          (item) =>
            item.href ===
            zipPath(
              path.slice(0, path.lastIndexOf("/") + 1),
              match[2].split("#")[0],
            ),
        )
      : null;
  };
  if (!coverImage && guideCoverPath)
    coverImage = imageFromCoverPage(guideCoverPath);
  const spineXhtmlItems = spineRefs
    .map((ref) => manifest.get(ref.idref))
    .filter((item) => item?.type.includes("xhtml"));
  // 일부 EPUB은 OPF 표지 메타데이터가 없다. 이 경우 파일명만으로 제외하지 않고,
  // spine XHTML이 실제 이미지 리소스를 참조하며 본문 텍스트가 거의 없는지를 함께
  // 확인해 표지 페이지를 추론한다.
  const inferredCoverPage = spineXhtmlItems.find((item) => {
    const referencedImage = imageFromCoverPage(item.href);
    if (!referencedImage) return false;
    const plainText = xhtmlBody(
      zipText(files.get(item.href) || new Uint8Array()),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (
      plainText.length < 80 &&
      (/cover|front/i.test(item.rawHref) ||
        /cover|front/i.test(referencedImage.rawHref) ||
        item === spineXhtmlItems[0])
    );
  });
  if (!coverImage && inferredCoverPage)
    coverImage = imageFromCoverPage(inferredCoverPage.href);
  // 표지 페이지는 정확히 하나만 선택한다. 같은 이미지를 사용하는 일반 본문이나
  // 속표지를 모두 표지로 분류하면 spine에서 표지가 중복되는 문제가 생긴다.
  if (!coverPagePaths.size) {
    const coverPage =
      inferredCoverPage ||
      (coverImage &&
        spineXhtmlItems.find(
          (item) => imageFromCoverPage(item.href)?.href === coverImage.href,
        ));
    if (coverPage) coverPagePaths.add(coverPage.href);
  }
  const spine = spineRefs
    .map((ref) => ({ ...ref, item: manifest.get(ref.idref) }))
    .filter(
      (ref) =>
        ref.item?.type.includes("xhtml") && !coverPagePaths.has(ref.item.href),
    );
  const chapterSources = spine;
  if (!chapterSources.length)
    throw new Error("불러올 XHTML 본문을 찾을 수 없습니다.");
  const navItem = Array.from(manifest.values()).find((item) =>
    item.properties.split(/\s+/).includes("nav"),
  );
  const ncxItem = Array.from(manifest.values()).find(
    (item) => item.type === "application/x-dtbncx+xml",
  );
  const tocEntries =
    navItem && files.has(navItem.href)
      ? tocEntriesFromNav(
          zipText(files.get(navItem.href)),
          navItem.href.slice(0, navItem.href.lastIndexOf("/") + 1),
        )
      : ncxItem && files.has(ncxItem.href)
        ? tocEntriesFromNcx(
            zipText(files.get(ncxItem.href)),
            ncxItem.href.slice(0, ncxItem.href.lastIndexOf("/") + 1),
          )
        : new Map();
  const chapterMeta = chapterSources.map(({ item, idref, linear }, index) => {
    const source = zipText(files.get(item.href) || new Uint8Array());
    const toc = tocEntries.get(item.href);
    return {
      index,
      idref,
      linear,
      path: item.href,
      rawHref: item.rawHref,
      source,
      body: xhtmlBody(source),
      tocTitle: toc?.title || xhtmlTitle(source) || `제${index + 1}장`,
      tocLevel: toc?.level || 1,
      tocParentPath: toc?.parentPath || null,
      includeInToc: Boolean(toc),
    };
  });
  const chapters = chapterMeta.map((meta) => ({
    id: createChapterId(),
    originalPath: meta.path,
    title: meta.tocTitle,
    level: meta.tocLevel,
    body: meta.body,
    fileName: meta.path.split("/").pop() || defaultChapterFileName(meta.index),
  }));
  const title =
    elementText(packageDocument, "title") || file.name.replace(/\.epub$/i, "");
  const author = elementText(packageDocument, "creator");
  const language = elementText(packageDocument, "language") || "ko";
  return {
    files,
    packagePath,
    packageBase,
    originalIdentifier,
    metadataExtras,
    manifest,
    spineRefs,
    coverPagePaths,
    coverImage,
    chapterMeta,
    chapters,
    navItem,
    tocEntries,
    title,
    author,
    language,
  };
}
