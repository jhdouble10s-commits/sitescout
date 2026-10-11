// Explicit Supabase project and Storage I/O. BookProject stays in ui.js.
// Live account/lease/project references are getters; verify failed upload, retry, save, reload, delete, and cross-account isolation after edits.
import { client as authClient } from "./auth-client.js";
import { isAccessVerified } from "./app-access.js";
import { immutableAssetPath, savedAssetPaths } from "./cloud-asset-path.js";

export function createCloudDraftIo(ctx) {
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
    renewEditLease,
  } = ctx;
  const mapLimited = async (items, worker) => {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({length:Math.min(4,items.length)},async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }));
    return results;
  };
  const readCloudProject = async (ownerId, projectId) => {
    const { data: record, error } = await authClient
      .from("epub_drafts")
      .select("payload,project_id,revision,updated_at")
      .eq("owner_id", ownerId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throw error;
    if (!record?.payload) throw new Error("서버 저장본을 찾을 수 없습니다.");
    return {
      ...record.payload,
      projectId: record.project_id,
      serverRevision: record.revision,
      lastServerSavedAt: record.updated_at,
    };
  };
  const listCloudProjects = async (ownerId) => {
    const client = await cloudReady;
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client
        .from("epub_drafts")
        .select("project_id,title,revision,updated_at")
        .eq("owner_id", ownerId)
        .order("updated_at", { ascending: false })
        .range(offset, offset + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) break;
    }
    const deletions = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client
        .from("epub_project_deletions")
        .select("project_id,revision")
        .eq("owner_id", ownerId)
        .order("project_id")
        .range(offset, offset + 499);
      if (error) throw error;
      deletions.push(...data);
      if (data.length < 500) break;
    }
    return { rows, deletions };
  };
  const loadDraftAssets = async (draft, isCurrent = () => true) => {
    const loaded = new Map();
    const missing = new Map();
    const ownerId = persistenceOwnerId();
    const results = await mapLimited(draft.assets || [],async asset => {
      let blob = null;
      {
        const client = await cloudReady;
        if (client && ctx.supabaseUser?.id === ownerId && isCurrent()) {
          try {
            for (const storagePath of await savedAssetPaths(
              ownerId,
              draft,
              asset,
            )) {
              if (!isCurrent()) break;
              const { data, error } = await client.storage
                .from("epub-assets")
                .download(storagePath, {
                  cacheNonce: asset.hash || String(Date.now()),
                });
              if (
                !error &&
                data &&
                (!asset.hash || (await assetHash(data)) === asset.hash)
              ) {
                blob = data;
                break;
              }
            }
          } catch {
            /* Keep the manifest entry for a later retry. */
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
          hash: asset.hash || (await assetHash(blob)),
          serverStoredHash: asset.serverStoredHash,
        }];
      return [asset.name,null,{...asset}];
    });
    results.forEach(([name,asset,unresolved]) => {
      if (asset) loaded.set(name,asset);
      else missing.set(name,unresolved);
    });
    if (!isCurrent()) {
      loaded.forEach(revokePreviewAssetUrl);
      return null;
    }
    return {loaded,missing};
  };
  const loadImportedSourceFiles = async (draft, isCurrent = () => true, loadedAssets = previewAssets) => {
    const source = draft.importedSource;
    if (!source) return null;
    // Legacy server payloads may still contain the original ZIP bytes.
    if (Array.isArray(source.files))
      return {
        ...source,
        files: new Map(
          source.files.map(([path, bytes]) => [path, new Uint8Array(bytes)]),
        ),
      };
    const files = new Map();
    const missing = [];
    const results = await mapLimited(source.resources || [],async resource => {
      let blob = null;
      if (ctx.supabaseUser?.id === persistenceOwnerId() && resource.storagePath && isCurrent()) {
        const client = await cloudReady;
        try {
          const { data, error } = await client.storage.from("epub-assets").download(resource.storagePath, {
            cacheNonce: resource.hash || String(Date.now()),
          });
          if (!error && data && (!resource.hash || (await assetHash(data)) === resource.hash)) blob = data;
        } catch { /* Keep the resource path for retry/export blocking. */ }
      }
      return blob ? [resource.path,new Uint8Array(await blob.arrayBuffer())] : [resource.path,null];
    });
    results.forEach(([path,bytes]) => { if (bytes) files.set(path,bytes); else missing.push(path); });
    // Image blobs are stored in the image asset manifest, not duplicated in
    // the source-resource manifest.
    for (const asset of loadedAssets.values())
      if (asset.originalPath && asset.blob)
        files.set(
          asset.originalPath,
          new Uint8Array(await asset.blob.arrayBuffer()),
        );
    if (!isCurrent()) return null;
    if (missing.length)
      console.warn(
        "가져온 EPUB 원본 리소스 일부를 복원하지 못했습니다.",
        missing,
      );
    return { ...source, files, sourceMissing: missing };
  };
  const saveCloudDraft = async (draft, assets, ownerId) => {
    if (ctx.deletedProjectIds.has(deletionKey(ownerId, draft.projectId)))
      throw new Error(
        "서버에서 삭제된 프로젝트입니다. 현재 탭의 원고를 내보내세요.",
      );
    if (!isAccessVerified())
      throw new Error("접근 권한을 다시 확인한 뒤 서버 동기화를 시도하세요.");
    const client = await cloudReady;
    if (!client || !ctx.supabaseUser || ctx.supabaseUser.id !== ownerId)
      throw new Error(
        "현재 회원의 서버 연결을 확인할 수 없습니다. 현재 탭의 원고는 유지됩니다.",
      );
    if (
      !ctx.editLease ||
      ctx.editLease.projectId !== draft.projectId ||
      ctx.editLease.expiresAt <= Date.now()
    )
      throw new Error(
        "편집 권한이 만료되었거나 다른 기기로 이전되었습니다. 현재 탭의 원고는 유지됩니다.",
      );
    const cloudAssets = [
      ...(draft.assets || []),
      ...(draft.importedSource?.resources || []),
    ];
    // A successful server save records serverStoredHash. Text-only saves consequently
    // do not rehash, upload, or download immutable objects.
    const toUpload = cloudAssets.filter((asset) => {
      asset.storagePath ||= immutableAssetPath(
        ownerId,
        draft.projectId,
        asset.hash,
      );
      return asset.serverStoredHash !== asset.hash;
    });
    let next = 0;
    const uploadOne = async () => {
      while (next < toUpload.length) {
        const asset = toUpload[next++];
        if (!isAccessVerified() || persistenceOwnerId() !== ownerId)
          throw new Error("접근 권한 확인이 필요합니다.");
        const stored = assets.get(asset.name);
        if (!stored?.blob)
          throw new Error(
            `${asset.sourceResource ? "원본 EPUB 리소스" : "이미지"} “${asset.originalPath || asset.name}”의 원본 파일을 찾지 못했습니다.`,
          );
        const { error } = await client.storage
          .from("epub-assets")
          .upload(asset.storagePath, stored.blob, {
            contentType: asset.type || "application/octet-stream",
            upsert: false,
          });
        if (error) {
          // An object can already exist after a prior interrupted upload. Only
          // this unknown object is downloaded and verified; known hashes never
          // take this path on a later text-only save.
          const existing = await client.storage
            .from("epub-assets")
            .download(asset.storagePath, { cacheNonce: asset.hash });
          if (
            existing.error ||
            !existing.data ||
            (await assetHash(existing.data)) !== asset.hash
          )
            throw new Error(
              `${asset.sourceResource ? "원본 EPUB 리소스" : "이미지"} 업로드 실패: ${error.message}`,
            );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, toUpload.length) }, uploadOne),
    );
    if (
      !isAccessVerified() ||
      persistenceOwnerId() !== ownerId ||
      ctx.deletedProjectIds.has(deletionKey(ownerId, draft.projectId))
    )
      throw new Error("접근 권한 또는 프로젝트 삭제 상태를 다시 확인하세요.");
    // The uploaded objects are immutable; include their confirmed hashes in
    // the server manifest even if this is the first save of the manuscript.
    cloudAssets.forEach((asset) => {
      asset.serverStoredHash = asset.hash;
    });
    const { data, error } = await client.rpc("save_epub_project", {
      p_project_id: draft.projectId,
      p_expected_revision: draft.serverRevision || 0,
      p_payload: draft,
      p_client_id: projectClientId,
      p_generation: ctx.editLease.generation,
    });
    if (error?.code === "PGRST202")
      throw new Error(
        "수동 저장용 서버 migration이 아직 적용되지 않았습니다. 현재 탭의 원고를 유지하세요.",
      );
    if (error?.code === "PT423") {
      void renewEditLease();
      throw new Error(
        "편집 권한이 만료되었거나 다른 기기로 이전되었습니다. 현재 탭의 원고는 유지됩니다.",
      );
    }
    if (error?.code === "PT409")
      throw new Error("서버 저장 충돌: 다른 탭에서 저장·삭제된 원고입니다. 현재 탭의 내용을 유지했습니다. 서버 저장본을 확인한 뒤 다시 진행하세요.");
    if (error) throw new Error(`서버 저장 실패: ${error.message}`);
    if (!Number.isSafeInteger(data?.revision))
      throw new Error(
        "서버 저장 응답이 올바르지 않습니다. 현재 탭의 원고는 유지됩니다.",
      );
    cloudAssets.forEach((asset) => {
      asset.serverStoredHash = asset.hash;
      const local = assets.get(asset.name);
      if (local) local.serverStoredHash = asset.hash;
      if (
        !asset.sourceResource &&
        previewAssets.get(asset.name)?.blob === local?.blob
      )
        previewAssets.get(asset.name).serverStoredHash = asset.hash;
    });
    if (ctx.importedEpub && draft.importedSource?.resources)
      ctx.importedEpub.resourceManifest = structuredClone(
        draft.importedSource.resources,
      );
    draft.serverRevision = data.revision;
    draft.lastServerSavedAt = data.saved_at || new Date().toISOString();
    return true;
  };
  const deleteCloudDraft = async (draft) => {
    if (!draft.serverRevision) return;
    if (!isAccessVerified())
      throw new Error("접근 권한을 다시 확인한 뒤 삭제하세요.");
    if (ctx.editLeaseSupported === true && !(await ensureEditLease()))
      throw new Error("편집 권한을 확인하지 못해 삭제하지 않았습니다.");
    const args = {
      p_project_id: draft.projectId,
      p_expected_revision: draft.serverRevision,
    };
    if (ctx.editLeaseSupported === true)
      Object.assign(args, {
        p_client_id: projectClientId,
        p_generation: ctx.editLease?.generation,
      });
    const { error } = await authClient.rpc("delete_epub_project", args);
    if (error?.code === "PT423") {
      void renewEditLease();
      throw new Error(
        "편집 권한이 만료되었거나 다른 기기로 이전되었습니다. 삭제하지 않았습니다.",
      );
    }
    if (error) throw error;
    // Immutable assets are intentionally retained. Garbage collection is a
    // separate, reference-aware operation, never part of a client save/delete.
  };
  return {
    loadDraftAssets,
    loadImportedSourceFiles,
    saveCloudDraft,
    deleteCloudDraft,
    readCloudProject,
    listCloudProjects,
  };
}
