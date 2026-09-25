// 新版 wechatide：地图往返、食堂入口、楼层位图回归。仅改模拟器内存，需 staging。
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=process.cwd()+'/miniprogram';
function tool(name,args=[]){const s=execFileSync('wechatide',['-c','Codex',name,'--project',project,...args],{encoding:'utf8',timeout:60000});const r=JSON.parse(s.slice(s.indexOf('{')));assert.equal(r.ok,true);assert.notEqual(r.result?.success,false);return r.result;}
function evaluate(fn){return tool('automation_evaluate',['--fn-source',fn.toString()]).result.result;}
function nav(action,url){tool('automation_navigate',['--action',action,'--url',url]);}
nav('switchTab','/pages/offcampus/offcampus');
evaluate(function(){getCurrentPages().slice(-1)[0].openMap({currentTarget:{dataset:{place:'place_baoshan_4th-canteen'}}});});
await new Promise(r=>setTimeout(r,1000));
let result=evaluate(function(){var p=getCurrentPages().slice(-1)[0];return {route:p.route,poi:p.data.detail.poiKey,back:p.poiReturnTab};});
assert.equal(result.route,'pages/map/map');assert.equal(result.poi,'place_baoshan_4th-canteen');assert.equal(result.back,'/pages/offcampus/offcampus');
evaluate(function(){getCurrentPages().slice(-1)[0].clearSelection();});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].route;}),'pages/offcampus/offcampus');
console.log('PASS dining -> map POI -> close returns dining');
nav('switchTab','/pages/map/map');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];p.loadedRelease.manifest.floors.push({id:'test-canteen-floor',buildingPlaceId:'place_baoshan_4th-canteen',isPublic:1});p.openDetailByKey('place_baoshan_4th-canteen');});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.detail.hasFloors;}),true);
evaluate(function(){getCurrentPages().slice(-1)[0].openFloors();});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].route;}),'pages/dining/dining');
console.log('PASS map canteen public-floor entry -> dining');
nav('reLaunch','/pages/floors/floors?placeId=place_baoshan_main-library');
for(let i=0;i<20;i++){if(evaluate(function(){return getCurrentPages().slice(-1)[0].data.ready;}))break;await new Promise(r=>setTimeout(r,500));}
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.view;}),'list');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];p.setView('plan');});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.view;}),'list');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];var f=p.floorRows[0];f.imageUrl='/api/public/media/test-local-fixture';var original=wx.cloud.callContainer;wx.cloud.callContainer=function(o){if(o.path===f.imageUrl){o.success({statusCode:200,header:{'content-type':'image/png'},data:wx.base64ToArrayBuffer('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=')});return;}return original.call(this,o);};p.setupFloor(f.id);wx.cloud.callContainer=original;});
await new Promise(r=>setTimeout(r,1000));
result=evaluate(function(){var p=getCurrentPages().slice(-1)[0];return {report:p.data.report,url:p.data.planImageUrl,exists:!!wx.getFileSystemManager().statSync(p.data.planImageUrl)};});
assert.equal(result.exists,true);assert.equal(result.report.view,'plan');assert.equal(result.report.planState,'ready');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];p.setView('list');p.switchFloor(p.floorRows[1].id);});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.hasPlan;}),false);
console.log('PASS floor bitmap proxy -> local file -> native image loaded; no-plan floor fallback');
nav('switchTab','/pages/offcampus/offcampus');
