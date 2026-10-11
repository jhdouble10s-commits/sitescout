import {
  isAccessVerified
} from "./chunk-BVXJMWKM.js";
import {
  client
} from "./chunk-VXYETN7S.js";

// cloud-asset-path.js
async function cloudAssetPath(ownerId, title, name) {
  const digest = async (value) => Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  return `${ownerId}/${await digest(title)}/${await digest(name)}`;
}
function immutableAssetPath(ownerId, projectId, hash) {
  if (![ownerId, projectId].every((value) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid asset identity");
  return `${ownerId}/projects/${projectId}/${hash}`;
}
function legacyEncodedAssetPath(ownerId, title, name) {
  if (typeof title !== "string" || typeof name !== "string") throw new Error("Invalid legacy asset identity");
  return `${ownerId}/${encodeURIComponent(title)}/${encodeURIComponent(name)}`;
}
async function savedAssetPath(ownerId, draft, asset) {
  if (!asset.storagePath) return cloudAssetPath(ownerId, draft.title, asset.name);
  if (asset.storagePath !== immutableAssetPath(ownerId, draft.projectId, asset.hash)) throw new Error("Invalid asset reference");
  return asset.storagePath;
}
async function savedAssetPaths(ownerId, draft, asset) {
  const current = await savedAssetPath(ownerId, draft, asset);
  if (asset.storagePath) return [current];
  const legacy = legacyEncodedAssetPath(ownerId, draft.title, asset.name);
  return legacy === current ? [current] : [current, legacy];
}

// cloud-draft-io.js
async function fetchProjectIndex(client2, ownerId, onRows = () => {
}) {
  const readPages = async (table, columns, order) => {
    const rows2 = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client2.from(table).select(columns).eq("owner_id", ownerId).order(order.column, { ascending: order.ascending !== false }).range(offset, offset + 499);
      if (error) throw error;
      rows2.push(...data);
      if (data.length < 500) return rows2;
    }
  };
  const rows = await readPages("epub_drafts", "project_id,title,revision,updated_at", { column: "updated_at", ascending: false });
  await onRows(rows);
  const deletions = await readPages("epub_project_deletions", "project_id,revision", { column: "project_id" });
  return { rows, deletions };
}
function createCloudDraftIo(ctx) {
  const {
    cloudReady,
    persistenceOwnerId,
    deletionKey,
    projectClientId,
    assetHash,
    previewAssets,
    unresolvedAssets,
    revokePreviewAssetUrl,
    clearPreviewAssets,
    renderAssetShelf,
    renderAssetRecovery,
    ensureEditLease,
    renewEditLease
  } = ctx;
  const mapLimited = async (items, worker) => {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }));
    return results;
  };
  const readCloudProject = async (ownerId, projectId) => {
    const { data: record, error } = await client.from("epub_drafts").select("payload,project_id,revision,updated_at").eq("owner_id", ownerId).eq("project_id", projectId).maybeSingle();
    if (error) throw error;
    if (!record?.payload) throw new Error("\uC11C\uBC84 \uC800\uC7A5\uBCF8\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return {
      ...record.payload,
      projectId: record.project_id,
      serverRevision: record.revision,
      lastServerSavedAt: record.updated_at
    };
  };
  const listCloudProjects = async (ownerId) => {
    const client2 = await cloudReady;
    return fetchProjectIndex(client2, ownerId);
  };
  const loadDraftAssets = async (draft, isCurrent = () => true) => {
    const loaded = /* @__PURE__ */ new Map();
    const missing = /* @__PURE__ */ new Map();
    const ownerId = persistenceOwnerId();
    const results = await mapLimited(draft.assets || [], async (asset) => {
      let blob = null;
      {
        const client2 = await cloudReady;
        if (client2 && ctx.supabaseUser?.id === ownerId && isCurrent()) {
          try {
            for (const storagePath of await savedAssetPaths(
              ownerId,
              draft,
              asset
            )) {
              if (!isCurrent()) break;
              const { data, error } = await client2.storage.from("epub-assets").download(storagePath, {
                cacheNonce: asset.hash || String(Date.now())
              });
              if (!error && data && (!asset.hash || await assetHash(data) === asset.hash)) {
                blob = data;
                break;
              }
            }
          } catch {
          }
        }
      }
      if (blob)
        return [asset.name, {
          type: asset.type,
          blob,
          url: URL.createObjectURL(blob),
          originalPath: asset.originalPath || "",
          isCover: Boolean(asset.isCover),
          storagePath: asset.storagePath,
          hash: asset.hash || await assetHash(blob),
          serverStoredHash: asset.serverStoredHash
        }];
      return [asset.name, null, { ...asset }];
    });
    results.forEach(([name, asset, unresolved]) => {
      if (asset) loaded.set(name, asset);
      else missing.set(name, unresolved);
    });
    if (!isCurrent()) {
      loaded.forEach(revokePreviewAssetUrl);
      return null;
    }
    return { loaded, missing };
  };
  const loadImportedSourceFiles = async (draft, isCurrent = () => true, loadedAssets = previewAssets) => {
    const source = draft.importedSource;
    if (!source) return null;
    if (Array.isArray(source.files))
      return {
        ...source,
        files: new Map(
          source.files.map(([path, bytes]) => [path, new Uint8Array(bytes)])
        )
      };
    const files = /* @__PURE__ */ new Map();
    const missing = [];
    const results = await mapLimited(source.resources || [], async (resource) => {
      let blob = null;
      if (ctx.supabaseUser?.id === persistenceOwnerId() && resource.storagePath && isCurrent()) {
        const client2 = await cloudReady;
        try {
          const { data, error } = await client2.storage.from("epub-assets").download(resource.storagePath, {
            cacheNonce: resource.hash || String(Date.now())
          });
          if (!error && data && (!resource.hash || await assetHash(data) === resource.hash)) blob = data;
        } catch {
        }
      }
      return blob ? [resource.path, new Uint8Array(await blob.arrayBuffer())] : [resource.path, null];
    });
    results.forEach(([path, bytes]) => {
      if (bytes) files.set(path, bytes);
      else missing.push(path);
    });
    for (const asset of loadedAssets.values())
      if (asset.originalPath && asset.blob)
        files.set(
          asset.originalPath,
          new Uint8Array(await asset.blob.arrayBuffer())
        );
    if (!isCurrent()) return null;
    if (missing.length)
      console.warn(
        "\uAC00\uC838\uC628 EPUB \uC6D0\uBCF8 \uB9AC\uC18C\uC2A4 \uC77C\uBD80\uB97C \uBCF5\uC6D0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
        missing
      );
    return { ...source, files, sourceMissing: missing };
  };
  const saveCloudDraft = async (draft, assets, ownerId) => {
    if (ctx.deletedProjectIds.has(deletionKey(ownerId, draft.projectId)))
      throw new Error(
        "\uC11C\uBC84\uC5D0\uC11C \uC0AD\uC81C\uB41C \uD504\uB85C\uC81D\uD2B8\uC785\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB97C \uB0B4\uBCF4\uB0B4\uC138\uC694."
      );
    if (!isAccessVerified())
      throw new Error("\uC811\uADFC \uAD8C\uD55C\uC744 \uB2E4\uC2DC \uD655\uC778\uD55C \uB4A4 \uC11C\uBC84 \uB3D9\uAE30\uD654\uB97C \uC2DC\uB3C4\uD558\uC138\uC694.");
    const client2 = await cloudReady;
    if (!client2 || !ctx.supabaseUser || ctx.supabaseUser.id !== ownerId)
      throw new Error(
        "\uD604\uC7AC \uD68C\uC6D0\uC758 \uC11C\uBC84 \uC5F0\uACB0\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4."
      );
    if (!ctx.editLease || ctx.editLease.projectId !== draft.projectId || ctx.editLease.expiresAt <= Date.now())
      throw new Error(
        "\uD3B8\uC9D1 \uAD8C\uD55C\uC774 \uB9CC\uB8CC\uB418\uC5C8\uAC70\uB098 \uB2E4\uB978 \uAE30\uAE30\uB85C \uC774\uC804\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4."
      );
    const cloudAssets = [
      ...draft.assets || [],
      ...draft.importedSource?.resources || []
    ];
    const toUpload = cloudAssets.filter((asset) => {
      asset.storagePath ||= immutableAssetPath(
        ownerId,
        draft.projectId,
        asset.hash
      );
      return asset.serverStoredHash !== asset.hash;
    });
    let next = 0;
    const uploadOne = async () => {
      while (next < toUpload.length) {
        const asset = toUpload[next++];
        if (!isAccessVerified() || persistenceOwnerId() !== ownerId)
          throw new Error("\uC811\uADFC \uAD8C\uD55C \uD655\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
        const stored = assets.get(asset.name);
        if (!stored?.blob)
          throw new Error(
            `${asset.sourceResource ? "\uC6D0\uBCF8 EPUB \uB9AC\uC18C\uC2A4" : "\uC774\uBBF8\uC9C0"} \u201C${asset.originalPath || asset.name}\u201D\uC758 \uC6D0\uBCF8 \uD30C\uC77C\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.`
          );
        const { error: error2 } = await client2.storage.from("epub-assets").upload(asset.storagePath, stored.blob, {
          contentType: asset.type || "application/octet-stream",
          upsert: false
        });
        if (error2) {
          const existing = await client2.storage.from("epub-assets").download(asset.storagePath, { cacheNonce: asset.hash });
          if (existing.error || !existing.data || await assetHash(existing.data) !== asset.hash)
            throw new Error(
              `${asset.sourceResource ? "\uC6D0\uBCF8 EPUB \uB9AC\uC18C\uC2A4" : "\uC774\uBBF8\uC9C0"} \uC5C5\uB85C\uB4DC \uC2E4\uD328: ${error2.message}`
            );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, toUpload.length) }, uploadOne)
    );
    if (!isAccessVerified() || persistenceOwnerId() !== ownerId || ctx.deletedProjectIds.has(deletionKey(ownerId, draft.projectId)))
      throw new Error("\uC811\uADFC \uAD8C\uD55C \uB610\uB294 \uD504\uB85C\uC81D\uD2B8 \uC0AD\uC81C \uC0C1\uD0DC\uB97C \uB2E4\uC2DC \uD655\uC778\uD558\uC138\uC694.");
    cloudAssets.forEach((asset) => {
      asset.serverStoredHash = asset.hash;
    });
    const { data, error } = await client2.rpc("save_epub_project", {
      p_project_id: draft.projectId,
      p_expected_revision: draft.serverRevision || 0,
      p_payload: draft,
      p_client_id: projectClientId,
      p_generation: ctx.editLease.generation
    });
    if (error?.code === "PGRST202")
      throw new Error(
        "\uC218\uB3D9 \uC800\uC7A5\uC6A9 \uC11C\uBC84 migration\uC774 \uC544\uC9C1 \uC801\uC6A9\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB97C \uC720\uC9C0\uD558\uC138\uC694."
      );
    if (error?.code === "PT423") {
      void renewEditLease();
      throw new Error(
        "\uD3B8\uC9D1 \uAD8C\uD55C\uC774 \uB9CC\uB8CC\uB418\uC5C8\uAC70\uB098 \uB2E4\uB978 \uAE30\uAE30\uB85C \uC774\uC804\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4."
      );
    }
    if (error?.code === "PT409")
      throw new Error("\uC11C\uBC84 \uC800\uC7A5 \uCDA9\uB3CC: \uB2E4\uB978 \uD0ED\uC5D0\uC11C \uC800\uC7A5\xB7\uC0AD\uC81C\uB41C \uC6D0\uACE0\uC785\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uB0B4\uC6A9\uC744 \uC720\uC9C0\uD588\uC2B5\uB2C8\uB2E4. \uC11C\uBC84 \uC800\uC7A5\uBCF8\uC744 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC9C4\uD589\uD558\uC138\uC694.");
    if (error) throw new Error(`\uC11C\uBC84 \uC800\uC7A5 \uC2E4\uD328: ${error.message}`);
    if (!Number.isSafeInteger(data?.revision))
      throw new Error(
        "\uC11C\uBC84 \uC800\uC7A5 \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD0ED\uC758 \uC6D0\uACE0\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4."
      );
    cloudAssets.forEach((asset) => {
      asset.serverStoredHash = asset.hash;
      const local = assets.get(asset.name);
      if (local) local.serverStoredHash = asset.hash;
      if (!asset.sourceResource && previewAssets.get(asset.name)?.blob === local?.blob)
        previewAssets.get(asset.name).serverStoredHash = asset.hash;
    });
    if (ctx.importedEpub && draft.importedSource?.resources)
      ctx.importedEpub.resourceManifest = structuredClone(
        draft.importedSource.resources
      );
    draft.serverRevision = data.revision;
    draft.lastServerSavedAt = data.saved_at || (/* @__PURE__ */ new Date()).toISOString();
    return true;
  };
  const deleteCloudDraft = async (draft) => {
    if (!draft.serverRevision) return;
    if (!isAccessVerified())
      throw new Error("\uC811\uADFC \uAD8C\uD55C\uC744 \uB2E4\uC2DC \uD655\uC778\uD55C \uB4A4 \uC0AD\uC81C\uD558\uC138\uC694.");
    if (ctx.editLeaseSupported === true && !await ensureEditLease())
      throw new Error("\uD3B8\uC9D1 \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD574 \uC0AD\uC81C\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    const args = {
      p_project_id: draft.projectId,
      p_expected_revision: draft.serverRevision
    };
    if (ctx.editLeaseSupported === true)
      Object.assign(args, {
        p_client_id: projectClientId,
        p_generation: ctx.editLease?.generation
      });
    const { error } = await client.rpc("delete_epub_project", args);
    if (error?.code === "PT423") {
      void renewEditLease();
      throw new Error(
        "\uD3B8\uC9D1 \uAD8C\uD55C\uC774 \uB9CC\uB8CC\uB418\uC5C8\uAC70\uB098 \uB2E4\uB978 \uAE30\uAE30\uB85C \uC774\uC804\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC0AD\uC81C\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
      );
    }
    if (error) throw error;
  };
  return {
    loadDraftAssets,
    loadImportedSourceFiles,
    saveCloudDraft,
    deleteCloudDraft,
    readCloudProject,
    listCloudProjects
  };
}

export {
  savedAssetPaths,
  fetchProjectIndex,
  createCloudDraftIo
};
