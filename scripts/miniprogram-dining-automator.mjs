// 新版微信开发者工具：先完成 wechatide -c Codex 授权。仅 GET staging 与模拟器内存数据。
// node scripts/miniprogram-dining-automator.mjs（当前模拟器须已选 staging）
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const project=path.resolve('miniprogram');
const out=path.resolve('tmp/dining-test');mkdirSync(out,{recursive:true});
function tool(name,args=[]) {
 const stdout=execFileSync('wechatide',['-c','Codex',name,'--project',project,...args],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
 const result=JSON.parse(stdout.slice(stdout.indexOf('{')));
 assert.equal(result.ok,true,stdout);assert.notEqual(result.result?.success,false,stdout);
 return result.result;
}
function evaluate(fn,...args) { return tool('automation_evaluate',['--fn-source',`function(){ return (${fn.toString()}).apply(null, ${JSON.stringify(args)}); }`]).result.result; }
function navigate(action,url){tool('automation_navigate',['--action',action,...(url?['--url',url]:[])]);}
function shot(name){tool('simulator_screenshot',['--path',path.join(out,name+'.png'),'--optimize','false']);}
async function ready() {
 for(let i=0;i<30;i++) {
  const state=evaluate(function(){var p=getCurrentPages().slice(-1)[0];return {loading:p.data.loading,error:p.data.error,schedule:p.schedule,merchantError:p.data.merchantError,scheduleError:p.data.scheduleError};});
  if(!state.loading && state.schedule){assert.equal(state.error,'');return state;}
  if(state.error) throw Error(state.error);
  await new Promise(r=>setTimeout(r,500));
 }
 throw Error('page load timeout');
}
navigate('switchTab','/pages/offcampus/offcampus');
const live=await ready();assert.equal(live.scheduleError,'');assert.equal(live.merchantError,'');
const original=evaluate(function(){var p=getCurrentPages().slice(-1)[0];return {canteens:p.canteens,schedule:p.schedule};});
assert.ok(original.canteens.length>0);shot('live-staging');
console.log('PASS staging cloud-container schedule + merchant-status + release',original.canteens.length);
const base=original.canteens[0];
const merchant={id:'test-merchant',name:'测试面馆',businessType:'面食',openingHours:'06:30–20:00',stallCode:'A01',phone:'021-12345678',avgPrice:'15 元',summary:'面食与小吃',media:[],menu:[{name:'牛肉面',price:'15 元',description:'现煮'}],floorId:'test-f1'};
const floors=[{floorId:'test-f1',levelCode:'F1',levelOrder:1,displayName:'一层餐厅',imageUrl:null,meals:['breakfast','lunner'],stallTypes:['面食','快餐'],merchants:[merchant]},{floorId:'test-f2',levelCode:'F2',levelOrder:2,displayName:'二层餐厅',imageUrl:null,meals:['lunner','latenight'],stallTypes:['小吃'],merchants:[]}];
const canteens=[{...base,closed:false,content:{detail:{media:[]}},floors},{...base,placeId:'test-nearby',name:'附近食堂',closed:false,content:{detail:{media:[]}},floors:[{...floors[0],floorId:'test-nearby-f1',merchants:[]}]}];
const schedule={...original.schedule,dayType:'weekday',arrangement:null};
evaluate(function(input){var p=getCurrentPages().slice(-1)[0];clearInterval(p.timer);p.generation++;p.canteens=input.canteens;p.schedule=input.schedule;p.statuses={'test-merchant':'temporarily_closed'};p.render();}, {canteens,schedule});
shot('weekday-list');
const pageId=base.placeId;
navigate('navigateTo','/pages/dining/dining?placeId='+encodeURIComponent(pageId)+'&floor=test-f2');await ready();
evaluate(function(input){var p=getCurrentPages().slice(-1)[0];clearInterval(p.timer);p.generation++;p.canteens=input.canteens;p.schedule=input.schedule;p.floorId='test-f2';p.statuses={'test-merchant':'temporarily_closed'};p.render();},{canteens,schedule});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.floor.floorId;}),'test-f2');
tool('automation_element_action',['--selector','.floor-tab','--action','tap']);
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.floor.floorId;}),'test-f1');
tool('automation_element_action',['--selector','.merchant-row','--action','tap']);
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.openMerchantId;}),'test-merchant');
shot('floor-merchant');
console.log('PASS selected floor deep-link, floor pill tap, merchant expansion');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];p.schedule.arrangement={scheduleId:'override',floors:[{floorId:'test-nearby-f1',noBreakfast:true}]};p.render();});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.wholeDayRest;}),true);
shot('weekday-override');
evaluate(function(){var p=getCurrentPages().slice(-1)[0];p.schedule.dayType='weekend';p.schedule.arrangement=null;p.render();});
assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.noArrangement;}),true);
shot('missing-arrangement');
console.log('PASS weekday override + weekend missing arrangement');
// 评分只检查真实 UI 和可选原因；成功/失败提交由单测 mock，避免写远端运营数据。
const saved=evaluate(function(){var key='shumap.feature-feedback';var saved=wx.getStorageSync(key);wx.removeStorageSync(key);return saved;});
try {
 navigate('navigateTo','/pages/feature-feedback/feature-feedback?page=search');
 tool('automation_element_action',['--selector','.star','--action','tap']);
 assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.rating;}),1);
 tool('automation_element_action',['--selector','textarea','--action','input','--value','测试草稿，不提交']);
 assert.equal(evaluate(function(){return getCurrentPages().slice(-1)[0].data.reason;}),'测试草稿，不提交');
 shot('rating');console.log('PASS rating selection + optional reason UI');
} finally {
 evaluate(function(saved){if(saved)wx.setStorageSync('shumap.feature-feedback',saved);else wx.removeStorageSync('shumap.feature-feedback');},saved);
 navigate('switchTab','/pages/offcampus/offcampus');
}
const consoleResult=tool('get_simulator_console',['--command','grep -i error']);
console.log('Console diagnostics:',JSON.stringify(consoleResult));
console.log('Screenshots:',out);
