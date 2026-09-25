// Requires staging dining fixture; modifies simulator memory only.
import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import path from 'node:path';
const project=path.resolve('miniprogram');function tool(name,args=[]){const out=execFileSync('wechatide',['-c','Codex',name,'--project',project,...args],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});const r=JSON.parse(out.slice(out.indexOf('{')));assert.equal(r.ok,true,out);assert.notEqual(r.result?.success,false,out);return r.result;}
const run=fn=>tool('automation_evaluate',['--fn-source',fn.toString()]).result.result;
const shot=name=>tool('simulator_screenshot',['--path','/tmp/'+name+'.png','--optimize','false']);
tool('automation_navigate',['--action','switchTab','--url','/pages/map/map']);
for(let i=0;i<40;i++){if(run(function(){return getCurrentPages().slice(-1)[0].data.ready;}))break;await new Promise(r=>setTimeout(r,500));}
run(function(){var p=getCurrentPages().slice(-1)[0];var poi=p.poiByKey.get('place_baoshan_4th-canteen');poi.detail.facts=[{label:'联系电话',value:'021-0000 0000'},{label:'所属学院',value:'示例学院 · 后勤餐饮服务中心及食堂管理办公室'},{label:'地址',value:'上海市宝山区上大路99号水秀楼东侧入口'}];poi.merchants=poi.merchants.filter(m=>m.id!=='unassigned');poi.merchants.push({...poi.merchants[0],id:'unassigned',name:'未分层便利店',floorId:null});poi.facilities=[{id:'test-wc',displayName:'卫生间',typeCode:'restroom',typeName:'卫生间',floorId:'stg_dining_20260926_floor_0_1',content:{locationDescription:'东侧走廊'}},{id:'test-water',displayName:'饮水点',typeCode:'water',typeName:'饮水点',floorId:'stg_dining_20260926_floor_0_2',content:{locationDescription:'西侧入口'}},{id:'test-battery',displayName:'充电宝',typeCode:'battery',typeName:'充电宝',floorId:null,content:{locationDescription:'服务台旁'}}];p.openDetailByKey(poi.poiKey);});
await new Promise(r=>setTimeout(r,1000));
let data=run(function(){var p=getCurrentPages().slice(-1)[0],c=p.selectComponent('#canteen-overview');return {height:p.data.sheetVisibleHeight,max:p.sheetMetrics.poi,content:p.poiContentHeight,component:!!c,floors:c.data.floors.length,others:c.data.others.map(x=>x.name),facilities:c.data.facilityRows};});
assert.equal(data.component,true);assert.equal(data.floors,2);assert.deepEqual(data.others,['未分层便利店']);assert.equal(data.facilities.length,3);assert.ok(data.content>data.height);assert.ok(data.height<=620);console.log('PASS native max-height + long fields + unassigned merchants + facilities',data.height,data.content);shot('shumap-native-long-top');
run(function(){var p=getCurrentPages().slice(-1)[0],c=p.selectComponent('#canteen-overview');c.facilityStatuses={'test-water':'unavailable'};c.render();});
// Skyline-safe method invocation; real scroll tested through the viewport tool below.
tool('automation_element_action',['--selector','.sheet-scroll','--action','scrollTo','--x','0','--y','2000']);shot('shumap-native-long-bottom');
run(function(){getCurrentPages().slice(-1)[0].selectComponent('#canteen-overview').openMerchant({currentTarget:{dataset:{id:'unassigned'}}});});
assert.equal(run(function(){return getCurrentPages().slice(-1)[0].data.detail.merchant.name;}),'未分层便利店');
run(function(){getCurrentPages().slice(-1)[0].backFromMerchant();});
run(function(){getCurrentPages().slice(-1)[0].selectComponent('#canteen-overview').openFloor({currentTarget:{dataset:{floor:'stg_dining_20260926_floor_0_1'}}});});
for(let i=0;i<30;i++){if(run(function(){return !getCurrentPages().slice(-1)[0].data.loading;}))break;await new Promise(r=>setTimeout(r,500));}
run(function(){var p=getCurrentPages().slice(-1)[0];p.facilities=[{id:'test-wc',displayName:'卫生间',typeCode:'restroom',typeName:'卫生间',floorId:'stg_dining_20260926_floor_0_1',content:{locationDescription:'东侧走廊'}},{id:'test-water',displayName:'饮水点',typeCode:'water',typeName:'饮水点',floorId:'stg_dining_20260926_floor_0_2',content:{locationDescription:'西侧入口'}},{id:'test-battery',displayName:'充电宝',typeCode:'battery',typeName:'充电宝',floorId:null,content:{}}];p.facilityStatuses={'test-water':'unavailable'};p.render();});
assert.deepEqual(run(function(){return getCurrentPages().slice(-1)[0].data.facilities.map(f=>f.id);}),['test-wc']);shot('shumap-native-floor-facilities');
run(function(){getCurrentPages().slice(-1)[0].switchFloor({currentTarget:{dataset:{id:'stg_dining_20260926_floor_0_2'}}});});
data=run(function(){var p=getCurrentPages().slice(-1)[0];return {facilities:p.data.facilities,photos:p.data.photos};});assert.deepEqual(data.facilities.map(x=>x.id),['test-water']);assert.equal(data.facilities[0].statusLabel,'暂停使用');console.log('PASS native merchant navigation + floor deep link + facility filtering/status');
console.log(tool('get_simulator_console',['--command','grep -i error']));

// Remove in-memory fixtures and leave the project showing its real staging data.
tool("simulator_refresh");
