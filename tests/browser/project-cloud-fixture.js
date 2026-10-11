// Stateful synthetic server shared by pages/contexts; never delegates an API request.
export function projectCloud() {
  const rows = new Map(), objects = new Map(), deletions = new Map();
  const leases = new Map();
  const state = {rows,objects,deletions,leases,leaseEnabled:false,failSave:false,failReadProjectId:null,missingMigration:false,failUpload:false,saveGate:null,uploadGate:null,onSave:null,onUpload:null,saveCount:0,uploadCount:0,uploadBytes:0,downloadDelayMs:0,activeDownloads:0,maxActiveDownloads:0};
  state.attach = async page => page.route('**/htzojicodwueivybovhy.supabase.co/**',async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/claim_epub_project_edit_lock')) {
      if (!state.leaseEnabled) return route.fulfill({status:404,json:{code:'PGRST202',message:'function absent'}});
      const args=request.postDataJSON(), now=Date.now(), existing=leases.get(args.p_project_id);
      if (existing?.expiresAt > now && existing.clientId !== args.p_client_id && !args.p_takeover)
        return route.fulfill({json:{granted:false,server_now:new Date(now).toISOString(),expires_at:new Date(existing.expiresAt).toISOString()}});
      // Match the server: a claim by the current holder renews its generation.
      const lease=existing?.expiresAt > now && existing.clientId===args.p_client_id
        ? existing : {clientId:args.p_client_id,generation:crypto.randomUUID(),expiresAt:0};
      lease.expiresAt=now+(args.p_ttl_seconds || 45)*1000;leases.set(args.p_project_id,lease);
      return route.fulfill({json:{granted:true,generation:lease.generation,server_now:new Date(now).toISOString(),expires_at:new Date(lease.expiresAt).toISOString()}});
    }
    if (url.pathname.endsWith('/renew_epub_project_edit_lock')) {
      const args=request.postDataJSON(), existing=leases.get(args.p_project_id), now=Date.now();
      if (!state.leaseEnabled || !existing || existing.clientId!==args.p_client_id || existing.generation!==args.p_generation || existing.expiresAt<=now)
        return route.fulfill({status:423,json:{code:'PT423',message:'Edit lease expired or transferred'}});
      existing.expiresAt=now+(args.p_ttl_seconds || 45)*1000;
      return route.fulfill({json:{granted:true,generation:existing.generation,server_now:new Date(now).toISOString(),expires_at:new Date(existing.expiresAt).toISOString()}});
    }
    if (url.pathname.endsWith('/release_epub_project_edit_lock')) {
      const args=request.postDataJSON(), existing=leases.get(args.p_project_id);
      if (existing?.clientId===args.p_client_id && existing.generation===args.p_generation) leases.delete(args.p_project_id);
      return route.fulfill({json:null});
    }
    if (url.pathname.endsWith('/save_epub_project') || url.pathname.endsWith('/overwrite_epub_project')) {
      const args = request.postDataJSON(); state.saveCount++; state.onSave?.(args); if (state.saveGate) await state.saveGate;
      const overwrite=url.pathname.endsWith('/overwrite_epub_project');
      if (state.missingMigration) return route.fulfill({status:404,json:{code:'PGRST202',message:'function absent'}});
      if (state.failSave) return route.fulfill({status:503,json:{message:'database unavailable'}});
      const old = rows.get(args.p_project_id), lease=leases.get(args.p_project_id);
      if ((state.leaseEnabled || overwrite) && (!lease || lease.clientId!==args.p_client_id || lease.generation!==args.p_generation || lease.expiresAt<=Date.now())) return route.fulfill({status:423,json:{code:'PT423',message:'Edit lease expired or transferred'}});
      if (deletions.has(args.p_project_id)) return route.fulfill({status:409,json:{code:'PT409',message:'Project deleted'}});
      if ([...rows.values()].some(row=>row.project_id!==args.p_project_id && row.payload.title===args.p_payload.title)) return route.fulfill({status:409,json:{code:'PT409',message:'title conflict'}});
      if (!overwrite && (old?.revision || 0) !== args.p_expected_revision) return route.fulfill({status:409,json:{code:'PT409',message:'conflict'}});
      const revision = (old?.revision || 0)+1, saved_at = new Date().toISOString();
      rows.set(args.p_project_id,{project_id:args.p_project_id,title:args.p_payload.title,revision,updated_at:saved_at,payload:{...args.p_payload,serverRevision:revision}});
      return route.fulfill({json:{revision,saved_at}});
    }
    if (url.pathname.endsWith('/delete_epub_project')) {
      const args=request.postDataJSON(),row=rows.get(args.p_project_id),lease=leases.get(args.p_project_id);
      if (state.leaseEnabled && (!lease || lease.clientId!==args.p_client_id || lease.generation!==args.p_generation || lease.expiresAt<=Date.now())) return route.fulfill({status:423,json:{code:'PT423',message:'Edit lease expired or transferred'}});
      if (row?.revision !== args.p_expected_revision) return route.fulfill({status:409,json:{code:'PT409',message:'conflict'}});
      rows.delete(args.p_project_id);
      deletions.set(args.p_project_id,{project_id:args.p_project_id,revision:row.revision+1,deleted_at:new Date().toISOString()});
      return route.fulfill({json:null});
    }
    if (url.pathname.endsWith('/epub_project_deletions')) return route.fulfill({json:[...deletions.values()]});
    if (url.pathname.endsWith('/epub_drafts')) {
      let data=[...rows.values()];const id=url.searchParams.get('project_id');if(id)data=data.filter(row=>`eq.${row.project_id}`===id);
      if(id===`eq.${state.failReadProjectId}`)return route.fulfill({status:503,json:{message:'synthetic read outage'}});
      return route.fulfill({json:request.headers().accept?.includes('object') ? data[0] || null : data});
    }
    if(url.pathname.includes('/storage/')) {
      const path=url.pathname.replace('/storage/v1/object/authenticated/','').replace('/storage/v1/object/','');
      if(request.method()==='POST') {
        state.uploadCount++;state.onUpload?.(path);if(state.uploadGate)await state.uploadGate;
        if(state.failUpload)return route.fulfill({status:503,json:{message:'upload unavailable'}});
        if(objects.has(path))return route.fulfill({status:409,json:{statusCode:'409',message:'already exists'}});
        const content = request.headers()['content-type'];
        let bytes=request.postDataBuffer();
        if(content?.startsWith('multipart/')) {const form=await new Response(bytes,{headers:{'content-type':content}}).formData();const file=[...form.values()].find(value=>typeof value !== 'string');bytes=Buffer.from(await file.arrayBuffer());}
        state.uploadBytes+=bytes.length;objects.set(path,bytes);return route.fulfill({json:{Key:path}});
      }
      if(request.method()==='GET') {
        state.activeDownloads++;
        state.maxActiveDownloads=Math.max(state.maxActiveDownloads,state.activeDownloads);
        try {
          if(state.downloadDelayMs)await new Promise(resolve=>setTimeout(resolve,state.downloadDelayMs));
          return objects.has(path)?route.fulfill({body:objects.get(path),contentType:'image/png'}):route.fulfill({status:404,json:{message:'missing'}});
        } finally {state.activeDownloads--;}
      }
      throw new Error('Image deletion/overwrite is not allowed in fixture');
    }
    return route.fallback();
  });
  return state;
}
