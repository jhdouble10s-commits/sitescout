// Hierarchy selection is kept independent from DOM and editor state so it can
// be tested without changing a chapter's identity or XHTML.
export const nearestPreviousTopLevelId = (orderedIds, parentById, selectedId) => {
  const position = orderedIds.indexOf(selectedId);
  if (position < 1) return null;
  return orderedIds.slice(0, position).reverse().find((id) => !parentById.has(id)) || null;
};

// Indent under the nearest preceding peer; repeating the shortcut can then
// descend one level at a time without skipping an existing intermediate row.
export const nearestPreviousSiblingId = (orderedIds, parentById, selectedId) => {
  const position = orderedIds.indexOf(selectedId);
  if (position < 1) return null;
  const parent = parentById.get(selectedId);
  return orderedIds.slice(0,position).reverse().find(id => parentById.get(id) === parent) || null;
};
