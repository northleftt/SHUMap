import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'mini-rating-'));
const require=createRequire(import.meta.url);
for (const [entry,name] of [['pages/feature-feedback/feature-feedback.ts','page'],['components/feature-feedback/index.ts','component']]) {
 buildSync({entryPoints:['miniprogram/miniprogram/'+entry],outfile:path.join(dir,name+'.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
}
let pageOptions, componentOptions;
globalThis.Page=o=>{pageOptions=o;};
globalThis.Component=o=>{componentOptions=o;};
require(path.join(dir,'page.cjs'));require(path.join(dir,'component.cjs'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
function setup() {
 const store={}; const requests=[];
 globalThis.wx={getStorageSync:key=>store[key],setStorageSync:(key,value)=>{store[key]=value;},navigateBack(){},cloud:{callContainer(o){requests.push(o);}}};
 const page={...pageOptions,data:structuredClone(pageOptions.data),setData(update){Object.assign(this.data,update);}};
 page.onLoad({page:'search'});
 return {page,store,requests};
}
test('rating required, failed submit retryable, low score reason optional, 204 success persists per page',async()=>{
 const {page,store,requests}=setup();
 await page.submit();assert.equal(requests.length,0);
 page.selectRating({currentTarget:{dataset:{value:2}}});
 let result=page.submit();assert.equal(requests.length,1);
 await page.submit();assert.equal(requests.length,1,'double submit suppressed');
 assert.deepEqual(requests[0].data,{page:'search',rating:2});
 requests[0].fail({errMsg:'offline'});await result;
 assert.equal(page.data.done,false);assert.ok(page.data.error);assert.equal(store['shumap.feature-feedback'],undefined);
 page.onReason({detail:{value:'  找不到食堂  '}});
 result=page.submit();assert.deepEqual(requests[1].data,{page:'search',rating:2,reason:'找不到食堂'});
 requests[1].success({statusCode:204,data:''});await result;
 assert.equal(page.data.done,true);assert.ok(store['shumap.feature-feedback'].search.submittedAt);
 assert.equal(store['shumap.feature-feedback'].shuttle,undefined);
 await page.submit();assert.equal(requests.length,2);
});
test('dismissal hides only its own feature and survives component remount',()=>{
 const {store}=setup();
 const mount=page=>({...componentOptions.methods,data:{page,hidden:false},setData(update){Object.assign(this.data,update);}});
 const first=mount('search');first.dismiss();assert.equal(first.data.hidden,true);assert.ok(store['shumap.feature-feedback'].search.dismissedAt);
 const second=mount('search');second.refresh();assert.equal(second.data.hidden,true);
 const shuttle=mount('shuttle');shuttle.refresh();assert.equal(shuttle.data.hidden,false);
});
