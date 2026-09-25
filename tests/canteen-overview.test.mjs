import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'canteen-overview-'));
const require = createRequire(import.meta.url);
function load(entry,name) {const outfile=path.join(dir,name+'.cjs');buildSync({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});return require(outfile);}
const web=load('src/lib/dining/facilities.ts','web');
const mini=load('miniprogram/miniprogram/lib/dining/facilities.ts','mini');
let component;
globalThis.Component=o=>{component=o;};
load('miniprogram/miniprogram/components/canteen-overview/index.ts','component');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const floors=[{floorId:'f1',levelCode:'F1',displayName:'一层'}, {floorId:'f2',levelCode:'F2',displayName:'二层'}];
const facilities=[{id:'wc',displayName:'卫生间',typeCode:'restroom',typeName:'卫生间',floorId:'f1',content:{locationDescription:'东侧走廊'}},{id:'water',displayName:'饮水点',typeCode:'water',typeName:'饮水点',floorId:'f2',content:{}},{id:'battery',displayName:'充电宝',typeCode:'battery',typeName:'充电宝',floorId:null,content:{locationDescription:'食堂入口'}}];
test('facilities preserve unassigned locations in overview and filter each floor exactly',()=>{
 for(const api of [web,mini]){
  const all=api.diningFacilities(facilities,floors,{water:'unavailable'});
  assert.equal(all.length,3);assert.equal(all[0].location,'1F · 东侧走廊');assert.equal(all[1].statusLabel,'暂停使用');assert.equal(all[2].location,'楼层待完善 · 食堂入口');
  const first=api.diningFacilities(facilities,floors,{water:'unavailable'},'f1');assert.deepEqual(first.map(x=>x.id),['wc']);assert.equal(first[0].location,'东侧走廊');
  assert.equal(api.diningFacilities(facilities,floors,null)[1].statusLabel,'');
 }
 assert.deepEqual(web.diningFacilities(facilities,floors,{}),mini.diningFacilities(facilities,floors,{}));
});
test('merchants on missing/private floors remain reachable without duplicating public-floor merchants',()=>{
 const merchants=[{id:'a',floorId:'f1'},{id:'b',floorId:null},{id:'c',floorId:'hidden'},{id:'d',floorId:'f2'}];
 for(const api of [web,mini]){assert.deepEqual(api.ungroupedMerchants(merchants,floors).map(x=>x.id),['b','c']);assert.equal(api.ungroupedMerchants(merchants,[]).length,4);}
});
function mount(){const c={...component.methods,data:{canteen:{closed:false,content:{detail:{media:[]}},floors:[{...floors[0],levelOrder:1,meals:['breakfast','lunner'],stallTypes:[],merchants:[]}]},merchants:[],facilities,placeId:'p'},generation:0,visible:true,schedule:null,statuses:{},facilityStatuses:null,setData(v,cb){Object.assign(this.data,v);cb?.();},triggerEvent(){}};return c;}
const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const schedule={date,dayType:'weekend',mealPeriods:[],arrangement:null};
test('overview keeps floor skeleton for missing arrangements, independently handles failures and ignores hidden responses',async()=>{
 const pending=[];globalThis.wx={cloud:{callContainer:o=>pending.push(o)}};
 const c=mount();const work=c.refresh();
 pending.find(o=>o.path.includes('dining/schedule')).success({statusCode:200,data:schedule});
 pending.find(o=>o.path.includes('merchant-status')).fail({errMsg:'offline'});
 pending.find(o=>o.path.includes('facility-status')).success({statusCode:200,data:{statuses:{water:'unavailable'}}});
 await work;assert.equal(c.data.noArrangement,true);assert.equal(c.data.floors.length,1);assert.equal(c.data.floors[0].statusText,'');assert.match(c.data.merchantError,/失败/);assert.equal(c.data.facilityRows[1].statusLabel,'暂停使用');
 pending.length=0;const late=c.refresh();c.stop();for(const o of pending)o.fail({errMsg:'offline'});await late;assert.equal(c.schedule.dayType,'weekend');
});
test('midnight clears stale arrangement before repaint',()=>{const c=mount();c.schedule={...schedule,date:'2000-01-01',arrangement:{scheduleId:'yesterday',floors:[]}};c.render();assert.equal(c.schedule,null);assert.equal(c.data.floors[0].statusText,'');});
test('normal building sections are gated from the canteen replacement on both clients',()=>{
 const native=readFileSync('miniprogram/miniprogram/pages/map/map.wxml','utf8');
 assert.match(native,/detail.isBuilding && !detail.isCanteen && detail.facilities.length > 0/);
 assert.match(native,/detail.isBuilding && !detail.isCanteen && detail.merchants.length > 0/);
 const web=readFileSync('src/pages/map/PoiDetailSheet.tsx','utf8');
 assert.match(web,/building.kindId !== "canteen" && facilities.length > 0/);
});

test('map height observer attaches when the release finishes loading',()=>{
 const source=readFileSync('src/pages/map/MapPage.tsx','utf8');
 assert.match(source,/observer\.observe\(element\);\s*return \(\) => observer\.disconnect\(\);\s*}, \[state\.releaseStatus\]\)/);
});
