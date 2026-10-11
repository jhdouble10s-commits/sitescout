// Chapter/TOC list presentation and hierarchy controls.
// ui.js owns BookProject and passes its current selection and chapter-save boundary; check selection, drag, nesting, and export TOC after edits.
import { nearestPreviousSiblingId } from "./chapter-hierarchy.js?v=20261007-66";
import {
  computePosition,
  autoUpdate,
  offset,
  flip,
  shift,
} from "https://cdn.jsdelivr.net/npm/@floating-ui/dom@1.8.0/+esm";

export function mountChapterToc({
  chapterList,
  parentToc,
  parentTocMap,
  collapsedTocRoots,
  tocExcluded,
  parentTocButton,
  parentTocMenu,
  parentTocPicker,
  bookProject,
  activeChapterIndex,
  selectedChapterElement,
  saveCurrentChapter,
  isCoverSelected,
}) {
  let arrangingChapters = false;
  // 내부 재정렬로 발생한 childList 변경은 다시 갱신하지 않는다.
  // 그렇지 않으면 select 변경 → 재정렬 → MutationObserver 갱신이 연속 실행되어 UI가 흔들린다.
  let ignoreInternalChapterMutation = false;
  let chapterControlsRefreshQueued = false;
  const chapterLabel = (chapter) =>
    Array.from(chapter.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .join(" ")
      .trim() || "제목 없는 장";
  const isDescendantOf = (index, ancestor) => {
    const seen = new Set();
    let parent = parentTocMap.get(index);
    while (parent !== undefined && !seen.has(parent)) {
      if (parent === ancestor) return true;
      seen.add(parent);
      parent = parentTocMap.get(parent);
    }
    return false;
  };
  const arrangeChapterList = ({ reorder = false } = {}) => {
    if (arrangingChapters) return;
    const chapters = Array.from(
      chapterList.querySelectorAll(".chapter[data-i]"),
    );
    // Row labels/handles/toggles below are view mutations too. Do not schedule
    // another render from our own decorations on every animation frame.
    if (chapters.length) ignoreInternalChapterMutation = true;
    const available = new Set(
      chapters.map((chapter) => Number(chapter.dataset.i)),
    );
    parentTocMap.forEach((parent, child) => {
      if (
        !available.has(parent) ||
        parent === child ||
        isDescendantOf(parent, child)
      )
        parentTocMap.delete(child);
    });
    const ordered = [];
    const visit = (parent, depth) => {
      let number = 0;
      chapters
        .filter(
          (chapter) =>
            (parentTocMap.get(Number(chapter.dataset.i)) ?? null) === parent,
        )
        .forEach((chapter) => {
          number += 1;
          chapter.querySelector(".num").textContent = String(number);
          chapter.style.setProperty(
            "padding-left",
            `${10 + depth * 18}px`,
            "important",
          );
          chapter.style.setProperty("--toc-depth", depth);
          ordered.push(chapter);
          visit(Number(chapter.dataset.i), depth + 1);
        });
    };
    visit(null, 0);
    if (ordered.length !== chapters.length) return;
    // A TOC hierarchy is not a spine order. Rendering/import/restore must not
    // move untoc'd interstitial chapters; only an explicit hierarchy move may.
    if (
      reorder &&
      !ordered.every((chapter, index) => chapter === chapters[index])
    ) {
      arrangingChapters = true;
      ignoreInternalChapterMutation = true;
      ordered.forEach((chapter) => chapterList.append(chapter));
      arrangingChapters = false;
    }
    const rootHasChildren = new Set();
    chapters.forEach((chapter) => {
      const index = Number(chapter.dataset.i);
      const parent = parentTocMap.get(index) ?? null;
      if (parent !== null && (parentTocMap.get(parent) ?? null) === null)
        rootHasChildren.add(parent);
    });
    chapters.forEach((chapter) => {
      const index = Number(chapter.dataset.i);
      const parent = parentTocMap.get(index) ?? null;
      let ancestor = parent;
      let isCollapsedDescendant = false;
      const seen = new Set([index]);
      while (
        ancestor !== null &&
        ancestor !== undefined &&
        !seen.has(ancestor)
      ) {
        if (collapsedTocRoots.has(ancestor)) {
          isCollapsedDescendant = true;
          break;
        }
        seen.add(ancestor);
        ancestor = parentTocMap.get(ancestor) ?? null;
      }
      chapter.hidden = isCollapsedDescendant;
      chapter.querySelector(".toc-toggle")?.remove();
      chapter.querySelector(".drag-handle")?.remove();
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.draggable = true;
      handle.title = "끌어서 순서 또는 목차 계층 변경";
      handle.setAttribute("aria-label", handle.title);
      handle.textContent = "≡";
      chapter.prepend(handle);
      if (parent === null && rootHasChildren.has(index)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "toc-toggle";
        const collapsed = collapsedTocRoots.has(index);
        toggle.textContent = collapsed ? "▸" : "▾";
        toggle.title = collapsed ? "하위 목차 펼치기" : "하위 목차 접기";
        toggle.setAttribute("aria-label", toggle.title);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (collapsedTocRoots.has(index)) collapsedTocRoots.delete(index);
          else collapsedTocRoots.add(index);
          arrangeChapterList();
        });
        chapter.append(toggle);
      }
    });
  };
  let stopParentTocPosition = null;
  const closeParentTocMenu = () => {
    stopParentTocPosition?.();
    stopParentTocPosition = null;
    parentTocMenu.hidden = true;
    parentTocButton.setAttribute("aria-expanded", "false");
  };
  const renderParentTocPicker = () => {
    const selected = parentToc.selectedOptions[0];
    parentTocButton.textContent = selected?.textContent || "최상위 목차";
    parentTocMenu.replaceChildren();
    Array.from(parentToc.options).forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "parent-toc-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.textContent = option.textContent;
      const choose = (event) => {
        event.preventDefault();
        event.stopPropagation();
        parentToc.value = option.value;
        closeParentTocMenu();
        parentToc.dispatchEvent(new Event("change", { bubbles: true }));
        parentTocButton.focus({ preventScroll: true });
      };
      item.addEventListener("pointerdown", choose);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") choose(event);
      });
      parentTocMenu.append(item);
    });
  };
  const refreshChapterControls = () => {
    arrangeChapterList();
    const activeIndex = activeChapterIndex();
    const chapters = Array.from(
      chapterList.querySelectorAll(".chapter[data-i]"),
    );
    parentToc.replaceChildren(new Option("최상위 목차", ""));
    chapters.forEach((chapter) => {
      const index = Number(chapter.dataset.i);
      if (
        index !== activeIndex &&
        !tocExcluded.has(index) &&
        !isDescendantOf(index, activeIndex)
      )
        parentToc.add(new Option(chapterLabel(chapter), String(index)));
      const visible = !tocExcluded.has(index);
      chapter.classList.toggle("is-toc-hidden", !visible);
    });
    parentToc.value = parentTocMap.get(activeIndex) ?? "";
    renderParentTocPicker();
  };
  const scheduleChapterControlsRefresh = () => {
    if (chapterControlsRefreshQueued) return;
    chapterControlsRefreshQueued = true;
    requestAnimationFrame(() => {
      chapterControlsRefreshQueued = false;
      refreshChapterControls();
    });
  };
  const chapterShortcutTargetIsEditable = (target) =>
    Boolean(
      target?.closest?.(
        "input,textarea,select,[contenteditable],.monaco-editor,.ProseMirror",
      ),
    );
  const setSelectedParent = (nextParent) => {
    const selected = selectedChapterElement();
    if (!selected) return;
    const selectedIndex = Number(selected.dataset.i);
    const previousParent = parentTocMap.get(selectedIndex);
    if ((previousParent ?? null) === (nextParent ?? null) || nextParent === selectedIndex
      || (nextParent !== null && isDescendantOf(nextParent,selectedIndex))) return;
    const chapters = Array.from(chapterList.querySelectorAll('.chapter[data-i]'));
    const anchorIndex = nextParent ?? previousParent;
    if (anchorIndex !== undefined && anchorIndex !== null) {
      const last = chapters.filter(chapter => {
        const index = Number(chapter.dataset.i);
        return chapter !== selected && !isDescendantOf(index,selectedIndex)
          && (index === anchorIndex || isDescendantOf(index,anchorIndex));
      }).at(-1);
      if (last) chapterList.insertBefore(selected,last.nextSibling);
    }
    if (nextParent === null) parentTocMap.delete(selectedIndex);
    else { parentTocMap.set(selectedIndex,nextParent); collapsedTocRoots.delete(nextParent); }
    bookProject.dirty = true;
    bookProject.revision++;
    arrangeChapterList({reorder:true});
    refreshChapterControls();
  };
  const moveSelectedChapterHierarchy = (direction) => {
    if (isCoverSelected() || !bookProject.selectedChapterId) return;
    const selected = selectedChapterElement();
    if (!selected) return;
    saveCurrentChapter();
    const chapters = Array.from(
      chapterList.querySelectorAll(".chapter[data-i]"),
    );
    if (direction === "outdent") {
      const parent = parentTocMap.get(Number(selected.dataset.i));
      if (parent === undefined) return;
      setSelectedParent(parentTocMap.get(parent) ?? null);
    } else {
      const chapterById = new Map(
        chapters.map((chapter) => [chapter.dataset.chapterId, chapter]),
      );
      const parentById = new Map(
        chapters.flatMap((chapter) => {
          const parentIndex = parentTocMap.get(Number(chapter.dataset.i));
          const parent = chapters.find(
            (item) => Number(item.dataset.i) === parentIndex,
          );
          return parent
            ? [[chapter.dataset.chapterId, parent.dataset.chapterId]]
            : [];
        }),
      );
      const parentId = nearestPreviousSiblingId(
        chapters.map((chapter) => chapter.dataset.chapterId),
        parentById,
        selected.dataset.chapterId,
      );
      const parent = parentId ? chapterById.get(parentId) : null;
      if (!parent) return;
      setSelectedParent(Number(parent.dataset.i));
    }
  };
  document.addEventListener("keydown", (event) => {
    if (
      !event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      chapterShortcutTargetIsEditable(event.target)
    )
      return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveSelectedChapterHierarchy("indent");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelectedChapterHierarchy("outdent");
    }
  });
  parentToc.addEventListener("change", () => {
    setSelectedParent(parentToc.value ? Number(parentToc.value) : null);
  });
  parentTocButton.addEventListener("click", () => {
    const opening = parentTocMenu.hidden;
    closeParentTocMenu();
    if (opening) {
      parentTocMenu.hidden = false;
      parentTocMenu.style.width = `${parentTocButton.getBoundingClientRect().width}px`;
      parentTocMenu.style.visibility = "hidden";
      stopParentTocPosition = autoUpdate(parentTocButton, parentTocMenu, () => {
        computePosition(parentTocButton, parentTocMenu, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [offset(5), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          if (parentTocMenu.hidden) return;
          const opening = parentTocMenu.style.visibility === "hidden";
          Object.assign(parentTocMenu.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${parentTocButton.getBoundingClientRect().width}px`,
            visibility: "visible",
          });
          if (opening)
            parentTocMenu
              .querySelector('[aria-selected="true"]')
              ?.focus({ preventScroll: true });
        });
      });
      parentTocButton.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !parentTocPicker.contains(event.target) &&
        !parentTocMenu.contains(event.target)
      )
        closeParentTocMenu();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !parentTocMenu.hidden) {
      closeParentTocMenu();
      parentTocButton.focus();
    }
    if (
      parentTocMenu.hidden ||
      !["ArrowDown", "ArrowUp"].includes(event.key) ||
      !parentTocMenu.contains(event.target)
    )
      return;
    event.preventDefault();
    const options = [...parentTocMenu.querySelectorAll("button")];
    options[
      (options.indexOf(document.activeElement) +
        options.length +
        (event.key === "ArrowDown" ? 1 : -1)) %
        options.length
    ]?.focus();
  });
  chapterList.addEventListener("click", scheduleChapterControlsRefresh);
  chapterList.addEventListener(
    "click",
    (event) => {
      if (event.target.closest(".toc-toggle")) return;
      const chapter = event.target.closest(".chapter[data-i]");
      if (!chapter) return;
      const bounds = chapter.getBoundingClientRect();
      if (bounds.right - event.clientX > 38) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = Number(chapter.dataset.i);
      if (tocExcluded.has(index)) tocExcluded.delete(index);
      else tocExcluded.add(index);
      bookProject.dirty = true;
      bookProject.revision++;
      refreshChapterControls();
    },
    true,
  );
  new MutationObserver(() => {
    if (ignoreInternalChapterMutation) {
      ignoreInternalChapterMutation = false;
      return;
    }
    scheduleChapterControlsRefresh();
  }).observe(chapterList, { childList: true, subtree: true });
  let draggedChapter = null;
  const clearDropIndicator = () =>
    chapterList
      .querySelectorAll(".drop-before,.drop-after,.drop-child")
      .forEach((chapter) =>
        chapter.classList.remove("drop-before", "drop-after", "drop-child"),
      );
  chapterList.addEventListener("dragstart", (event) => {
    const handle = event.target.closest(".drag-handle");
    const chapter = handle?.closest(".chapter[data-i]");
    if (!chapter) return;
    draggedChapter = chapter;
    chapter.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", chapter.dataset.i);
  });
  chapterList.addEventListener("dragover", (event) => {
    const target = event.target.closest(".chapter[data-i]");
    if (!draggedChapter || !target || target === draggedChapter) return;
    event.preventDefault();
    clearDropIndicator();
    const bounds = target.getBoundingClientRect();
    const childDrop =
      event.clientX > bounds.left + Math.min(72, bounds.width * 0.35);
    target.classList.add(
      childDrop
        ? "drop-child"
        : event.clientY < bounds.top + bounds.height / 2
          ? "drop-before"
          : "drop-after",
    );
    event.dataTransfer.dropEffect = "move";
  });
  chapterList.addEventListener("drop", (event) => {
    const target = event.target.closest(".chapter[data-i]");
    if (!draggedChapter || !target || target === draggedChapter) return;
    event.preventDefault();
    const draggedIndex = Number(draggedChapter.dataset.i);
    const targetIndex = Number(target.dataset.i);
    const bounds = target.getBoundingClientRect();
    const childDrop =
      event.clientX > bounds.left + Math.min(72, bounds.width * 0.35);
    let nextParent = childDrop
      ? (parentTocMap.get(targetIndex) ?? targetIndex)
      : (parentTocMap.get(targetIndex) ?? null);
    if (nextParent === draggedIndex || isDescendantOf(nextParent, draggedIndex))
      nextParent = null;
    if (nextParent === null) parentTocMap.delete(draggedIndex);
    else parentTocMap.set(draggedIndex, nextParent);
    const before = !childDrop && event.clientY < bounds.top + bounds.height / 2;
    chapterList.insertBefore(
      draggedChapter,
      before ? target : target.nextSibling,
    );
    collapsedTocRoots.delete(draggedIndex);
    bookProject.dirty = true;
    bookProject.revision++;
    arrangeChapterList({ reorder: true });
    refreshChapterControls();
  });
  chapterList.addEventListener("dragend", () => {
    draggedChapter?.classList.remove("is-dragging");
    draggedChapter = null;
    clearDropIndicator();
  });
  refreshChapterControls();
  return {
    chapterLabel,
    refreshChapterControls,
    scheduleChapterControlsRefresh,
  };
}
