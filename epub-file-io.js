// EPUB ZIP, XML, path, and TOC serialization/parsing helpers.
// ui.js keeps the BookProject import/export application boundary; verify manifest, spine, nav/NCX, cover, assets, and XHTML after changes.
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm";

export function createEpubFileIo({
  attributeValue,
  defaultChapterFileName,
  tocExcluded,
  parentTocMap,
}) {
  const epubText = (value) => new TextEncoder().encode(value);
  const epubEscape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character],
    );
  const createEpubZip = async (files) => {
    const archive = new JSZip();
    // EPUB requires this exact entry to be first and stored (not compressed).
    const mimetype = files.find((file) => file.name === "mimetype");
    if (mimetype)
      archive.file("mimetype", mimetype.data, { compression: "STORE" });
    files
      .filter((file) => file.name !== "mimetype")
      .forEach((file) => {
        archive.file(file.name, file.data, {
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
      });
    return archive.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      streamFiles: false,
    });
  };
  const normaliseImportedFootnoteLinks = (body, chapterPath, footnotePath) =>
    String(body).replace(/<a\b([^>]*)>/gi, (all, attributes) => {
      const href = attributeValue(attributes, "href");
      const id = href.split("#")[1] || "";
      const targetPath = href
        ? zipPath(
            chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1),
            href.split("#")[0],
          )
        : "";
      if (!id || targetPath !== footnotePath) return all;
      const withoutTarget = attributes.replace(
        /\s+target\s*=\s*(["']).*?\1/gi,
        "",
      );
      if (
        /(?:^|\s)noteref(?:\s|$)/i.test(
          attributeValue(withoutTarget, "epub:type"),
        )
      )
        return `<a${withoutTarget}>`;
      return `<a${withoutTarget} epub:type="noteref">`;
    });
  const importedMetadata = (imported, draft) => {
    const identifier = imported.identifier || `urn:uuid:${crypto.randomUUID()}`;
    return `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${epubEscape(identifier)}</dc:identifier><dc:title>${epubEscape(draft.title || "새 전자책")}</dc:title>${draft.author ? `<dc:creator>${epubEscape(draft.author)}</dc:creator>` : ""}<dc:language>${epubEscape(draft.language || "ko")}</dc:language>${imported.metadataExtras || ""}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata>`;
  };
  const makeEpubNav = (
    chapters,
    filenames = chapters.map((_, index) => defaultChapterFileName(index)),
    structure = { tocExcluded, parentTocMap },
  ) => {
    const included = chapters.filter(
      (_, index) => !structure.tocExcluded.has(index),
    );
    const visible = new Set(
      included.map((_, index) => chapters.indexOf(included[index])),
    );
    const parentFor = (index) => {
      const seen = new Set([index]);
      let parent = structure.parentTocMap.get(index);
      while (parent !== undefined && !seen.has(parent)) {
        if (visible.has(parent)) return parent;
        seen.add(parent);
        parent = structure.parentTocMap.get(parent);
      }
      return null;
    };
    const items = included.map((chapter) => ({
      chapter,
      index: chapters.indexOf(chapter),
    }));
    const render = (parent) =>
      items
        .filter((item) => parentFor(item.index) === parent)
        .map((item) => {
          const children = render(item.index);
          const link = `<a href="text/${epubEscape(filenames[item.index])}">${epubEscape(item.chapter.title || "제목 없는 장")}</a>`;
          return `<li>${link}${children ? `<ol>${children}</ol>` : ""}</li>`;
        })
        .join("");
    const landmarks = (structure.landmarks || [])
      .map(
        (item) =>
          `<li><a epub:type="${epubEscape(item.type)}" href="${epubEscape(item.href)}">${epubEscape(item.title)}</a></li>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><h1>목차</h1><ol>${render(null)}</ol></nav>${landmarks ? `<nav epub:type="landmarks" hidden="hidden"><h2>안내</h2><ol>${landmarks}</ol></nav>` : ""}</body></html>`;
  };
  const replaceXhtmlBody = (source, body) =>
    /<body\b[^>]*>[\s\S]*?<\/body\s*>/i.test(source)
      ? source.replace(
          /(<body\b[^>]*>)[\s\S]*?(<\/body\s*>)/i,
          (_, opening, closing) => opening + body + closing,
        )
      : source;
  const replaceXhtmlTitle = (source, title) =>
    /<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(source)
      ? source.replace(
          /(<title\b[^>]*>)[\s\S]*?(<\/title\s*>)/i,
          (_, opening, closing) => opening + epubEscape(title) + closing,
        )
      : source;
  const relativeEpubPath = (fromFile, toFile) => {
    const from = fromFile.split("/").slice(0, -1);
    const to = toFile.split("/");
    while (from.length && to.length && from[0] === to[0]) {
      from.shift();
      to.shift();
    }
    return (
      `${"../".repeat(from.length)}${to.join("/")}` || toFile.split("/").pop()
    );
  };
  const zipText = (bytes) =>
    new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const zipPath = (basePath, href) => {
    try {
      return decodeURIComponent(
        new URL(href, `https://epub.local/${basePath}`).pathname.slice(1),
      );
    } catch {
      return href.replace(/^\.\//, "");
    }
  };
  const unzipEpub = async (file) => {
    let archive;
    try {
      archive = await JSZip.loadAsync(file);
    } catch {
      throw new Error("유효한 EPUB(ZIP) 파일이 아닙니다.");
    }
    const files = new Map();
    await Promise.all(
      Object.entries(archive.files)
        .filter(([, entry]) => !entry.dir)
        .map(async ([name, entry]) =>
          files.set(name, await entry.async("uint8array")),
        ),
    );
    return files;
  };
  const xmlDocument = (source, label) => {
    const documentNode = new DOMParser().parseFromString(
      source,
      "application/xml",
    );
    if (documentNode.querySelector("parsererror"))
      throw new Error(`${label} 형식이 올바르지 않습니다.`);
    return documentNode;
  };
  const elementText = (documentNode, name) =>
    documentNode.getElementsByTagNameNS("*", name)[0]?.textContent?.trim() ||
    "";
  const xhtmlBody = (source) =>
    /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(source)?.[1] ?? source;
  const xhtmlTitle = (source) =>
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i
      .exec(source)?.[1]
      .replace(/<[^>]+>/g, "")
      .trim() || "";
  const tocEntriesFromNcx = (source, basePath) => {
    const documentNode = xmlDocument(source, "toc.ncx");
    const entries = new Map();
    const visit = (node, level, parentPath = null) =>
      Array.from(node.children)
        .filter((child) => child.localName === "navPoint")
        .map((point) => {
          const href =
            point
              .getElementsByTagNameNS("*", "content")[0]
              ?.getAttribute("src") || "";
          const path = zipPath(basePath, href.split("#")[0]);
          const title =
            point.getElementsByTagNameNS("*", "text")[0]?.textContent?.trim() ||
            "";
          if (path && !entries.has(path))
            entries.set(path, { title, level, parentPath });
          return {
            path,
            fragment: href.includes("#")
              ? `#${href.split("#").slice(1).join("#")}`
              : "",
            title,
            children: visit(point, level + 1, path || parentPath),
          };
        });
    entries.tree = visit(
      documentNode.getElementsByTagNameNS("*", "navMap")[0] || documentNode,
      1,
    );
    return entries;
  };
  const tocEntriesFromNav = (source, basePath) => {
    const documentNode = new DOMParser().parseFromString(source, "text/html");
    const toc =
      Array.from(documentNode.querySelectorAll("nav")).find((node) =>
        /(^|\s)toc(\s|$)/i.test(
          node.getAttribute("epub:type") || node.getAttribute("type") || "",
        ),
      ) || documentNode.querySelector("nav");
    const entries = new Map();
    const visit = (list, level, parentPath = null) =>
      Array.from(list?.children || [])
        .filter((node) => node.tagName === "LI")
        .map((item) => {
          const link = item.querySelector(":scope > a");
          const href = link?.getAttribute("href") || "";
          const path = href ? zipPath(basePath, href.split("#")[0]) : "";
          const title = link?.textContent.trim() || "";
          if (path && !entries.has(path))
            entries.set(path, { title, level, parentPath });
          return {
            path,
            fragment: href.includes("#")
              ? `#${href.split("#").slice(1).join("#")}`
              : "",
            title,
            children: visit(
              Array.from(item.children).find((node) => node.tagName === "OL"),
              level + 1,
              path || parentPath,
            ),
          };
        });
    entries.tree = visit(toc?.querySelector("ol"), 1);
    return entries;
  };
  return {
    epubText,
    epubEscape,
    createEpubZip,
    normaliseImportedFootnoteLinks,
    importedMetadata,
    makeEpubNav,
    replaceXhtmlBody,
    replaceXhtmlTitle,
    relativeEpubPath,
    zipText,
    zipPath,
    unzipEpub,
    xmlDocument,
    elementText,
    xhtmlBody,
    xhtmlTitle,
    tocEntriesFromNcx,
    tocEntriesFromNav,
  };
}
