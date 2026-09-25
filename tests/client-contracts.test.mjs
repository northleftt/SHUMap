import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSync } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
function load(entry){const bundle=buildSync({entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));}
const {resolveClientContract,projectReleaseManifest}=await load('worker/lib/client-contracts.ts');
const {getCurrentRelease,getVersionedRelease,getPublicMapAsset}=await load('worker/modules/public.ts');
const {retainReleaseAssets}=await load('worker/lib/release-asset-lease.ts');
const legacy=await load('tests/fixtures/contracts/legacy/manifestContract.ts');
const legacyWeb=await load('tests/fixtures/contracts/legacy/webManifestContract.ts');
const modern=await load('src/lib/release/manifestContract.ts');
const native=await load('miniprogram/miniprogram/lib/release/manifestContract.ts');
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/release-manifest-live.json'));
function manifest(){const x=structuredClone(fixture);x.floors=[{id:'floor_test',buildingPlaceId:x.places[0].id,levelCode:'F1',levelOrder:1,displayName:'测试一层',isPublic:1,imageUrl:'/api/public/media/test'}];return x;}
const request=query=>new Request('https://test/api/public/releases/current'+query);
test('missing contract is permanently legacy; invalid, duplicate and retired contracts fail explicitly',()=>{
 assert.equal(resolveClientContract(request('')),'legacy');assert.equal(resolveClientContract(request('?contract=map-2026-09')),'map-2026-09');
 for(const q of ['?contract=','?contract=future','?contract=legacy&contract=map-2026-09','?contract=__proto__'])assert.throws(()=>resolveClientContract(request(q)),e=>e.status===400);
 assert.throws(()=>resolveClientContract(request(''),{legacy:{status:'retired',successor:'map-2026-09'},'map-2026-09':{status:'supported'}}),e=>e.status===410);
});
test('same content supports historical Web/native strict parsers and modern clients without leaking future keys',()=>{
 const x=manifest();x.future='not on wire';x.places[0].future='not on wire';x.floors[0].future='not on wire';
 const old=projectReleaseManifest(x,'legacy'),current=projectReleaseManifest(x,'map-2026-09');
 assert.equal(old.floors[0].imageUrl,undefined);assert.equal(current.floors[0].imageUrl,'/api/public/media/test');
 assert.equal(old.future,undefined);assert.equal(current.places[0].future,undefined);assert.equal(current.floors[0].future,undefined);
 legacy.parseReleaseManifest(old);legacyWeb.parseReleaseManifest(old);modern.parseReleaseManifest(current);native.parseReleaseManifest(current);assert.throws(()=>legacy.parseReleaseManifest(current),/imageUrl/);
 assert.equal(x.floors[0].imageUrl,'/api/public/media/test');
});
function envFor(x){const text=JSON.stringify(x);return {DB:{prepare(){return {bind(){return this;},async first(){return {id:x.release.id,version:x.release.version,artifact_key:'artifact',artifact_sha256:'canonical'};}}}},SHUMAP_BUCKET:{async get(){return {size:Buffer.byteLength(text),json:async()=>JSON.parse(text)};}}};}
test('ETags and lengths represent projected bytes; versioned/current contracts match; 304 only for exact representation',async()=>{
 const x=manifest(),env=envFor(x);const old=await getCurrentRelease(env,request(''));const current=await getCurrentRelease(env,request('?contract=map-2026-09'));
 const oldText=await old.text(),newText=await current.text();assert.notEqual(old.headers.get('etag'),current.headers.get('etag'));assert.equal(Number(current.headers.get('content-length')),Buffer.byteLength(newText));assert.equal(old.headers.get('x-shumap-contract'),'legacy');
 const v=await getVersionedRelease(env,x.release.id,request('?contract=map-2026-09'));assert.equal(await v.text(),newText);assert.match(v.headers.get('cache-control'),/immutable/);
 const hit=new Request(request('').url,{headers:{'if-none-match':old.headers.get('etag')}});assert.equal((await getCurrentRelease(env,hit)).status,304);
 const miss=new Request(request('?contract=map-2026-09').url,{headers:{'if-none-match':old.headers.get('etag')}});assert.equal((await getCurrentRelease(env,miss)).status,200);legacy.parseReleaseManifest(JSON.parse(oldText));
});
function database() {
 const sqlite = new DatabaseSync(':memory:');
 for (const f of fs.readdirSync('migrations-v2').filter(x => x.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync('migrations-v2/' + f, 'utf8'));
 const DB = {
  prepare(sql) {
   return {
    values: [],
    bind(...v) { this.values = v; return this; },
    async first() { return sqlite.prepare(sql).get(...this.values) || null; },
    async run() { return sqlite.prepare(sql).run(...this.values); },
   };
  },
 };
 return { sqlite, DB };
}
test('asset leases allow only explicitly retained published membership and never override revoked media',async()=>{
 const {sqlite,DB}=database();const now=new Date().toISOString();const svg='<svg></svg>';
 sqlite.prepare(`insert into media_assets(id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at) values('m','private','map.svg','image/svg+xml',?,'hash','approved',?)`).run(Buffer.byteLength(svg),now);
 sqlite.prepare(`insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('a','campus_svg','m','hash','{}',?)`).run(now);
 sqlite.prepare(`insert into map_versions(id,campus_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at) values('v','campus_baoshan','a','test','svg_viewbox','{}','published',?)`).run(now);
 sqlite.prepare(`insert into releases(id,version,schema_version,status,created_at) values('r','r',2,'superseded',?)`).run(now);sqlite.exec(`insert into release_map_versions values('r','v')`);
 const env={DB,SHUMAP_BUCKET:{async get(){return {size:Buffer.byteLength(svg),body:svg};}}};
 await assert.rejects(getPublicMapAsset(env,'v'),e=>e.status===404);await retainReleaseAssets(env,'r',now).run();assert.equal((await getPublicMapAsset(env,'v')).status,200);
 sqlite.exec("update media_assets set status='rejected'");await assert.rejects(getPublicMapAsset(env,'v'),e=>e.status===404);sqlite.exec("update media_assets set status='approved';update release_asset_leases set expires_at='2000-01-01T00:00:00Z'");await assert.rejects(getPublicMapAsset(env,'v'),e=>e.status===404);
 sqlite.exec("update release_asset_leases set expires_at='2099-01-01T00:00:00Z';update releases set status='failed'");await assert.rejects(getPublicMapAsset(env,'v'),e=>e.status===404);sqlite.close();
});
test('native and web advertise one pinned contract and native cache namespaces isolate environment',async()=>{
 const webClient=fs.readFileSync('shared/client-contracts/client.ts','utf8'),miniClient=fs.readFileSync('miniprogram/miniprogram/lib/client-contract.ts','utf8');assert.equal(webClient,miniClient);
 const {releaseCacheNamespace}=await load('miniprogram/miniprogram/lib/release/loader.ts');assert.notEqual(releaseCacheNamespace('prod'),releaseCacheNamespace('staging'));assert.match(releaseCacheNamespace('prod'),/map-2026-09/);
});
