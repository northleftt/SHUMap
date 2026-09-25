import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'mini-dining-'));
const require = createRequire(import.meta.url);
function load(entry, name) {
  const outfile = path.join(dir, name + '.cjs');
  buildSync({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(outfile);
}
const web = load('src/lib/dining/schedule.ts', 'web');
const mini = load('miniprogram/miniprogram/lib/dining/schedule.ts', 'mini');
const { diningView } = load('miniprogram/miniprogram/lib/dining/view.ts', 'view');
const { diningPage } = load('miniprogram/miniprogram/lib/dining/page.ts', 'page');
test.after(() => rmSync(dir, { recursive: true, force: true }));
const periods = [
  { meal: 'breakfast', startTime: '06:30', endTime: '09:30', sortOrder: 10 },
  { meal: 'lunner', startTime: '11:00', endTime: '13:00', sortOrder: 20 },
  { meal: 'lunner', startTime: '16:40', endTime: '18:30', sortOrder: 30 },
  { meal: 'latenight', startTime: '19:30', endTime: '22:00', sortOrder: 40 },
];
const schedule = { date: '2026-09-25', dayType: 'weekday', mealPeriods: periods, arrangement: null };
const floor = { floorId: 'f1', levelCode: 'F1', levelOrder: 1, displayName: '一层', imageUrl: null, meals: ['breakfast', 'lunner'], stallTypes: ['面食'], merchants: [] };
const canteen = { placeId: 'c1', name: '一食堂', campusKey: 'baoshan', campusLabel: '宝山校区', closed: false, content: { detail: { media: [] } }, floors: [floor] };

test('Web / mini dining rules agree across all day types, arrangements, meal boundaries and lifecycles', () => {
  for (const dayType of ['weekday', 'weekend', 'holiday', 'winter_break', 'summer_break']) {
    for (const arrangement of [null, { scheduleId: 's', floors: [] }, { scheduleId: 's', floors: [{ floorId: 'f1', noBreakfast: true }] }, { scheduleId: 's', floors: [{ floorId: 'f1', noBreakfast: false }] }]) {
      const data = { ...schedule, dayType, arrangement };
      assert.deepEqual(mini.parseDiningScheduleResponse(data), web.parseDiningScheduleResponse(data));
      for (const nowMinutes of [0, 390, 569, 570, 660, 779, 780, 1000, 1120, 1170, 1320, 1439]) {
        assert.equal(mini.periodBarText(data, nowMinutes), web.periodBarText(data, nowMinutes));
        for (const placeClosed of [false, true]) {
          const input = { ...data, periods, floorId: 'f1', meals: floor.meals, nowMinutes, placeClosed };
          assert.deepEqual(mini.floorOpenStatus(input), web.floorOpenStatus(input));
        }
      }
    }
  }
});

test('Shanghai clock handles midnight / year rollover without device timezone or Intl dependency', () => {
  for (const instant of ['2026-09-25T15:59:00Z','2026-09-25T16:00:00Z','2026-12-31T16:01:00Z']) {
    assert.equal(mini.shanghaiToday(Date.parse(instant)), web.shanghaiToday(Date.parse(instant)));
    assert.equal(mini.shanghaiMinutes(Date.parse(instant)), web.shanghaiMinutes(Date.parse(instant)));
  }
});

test('view distinguishes missing arrangements, empty floors, rest and weekday overrides', () => {
  assert.equal(diningView([canteen], { ...schedule, dayType: 'weekend' }, {}, 700, null).noArrangement, true);
  const override = { ...schedule, arrangement: { scheduleId: 's', floors: [] } };
  const closed = diningView([canteen], override, {}, 700, null, 'c1', 'invalid');
  assert.equal(closed.wholeDayRest, true);
  assert.equal(closed.floor.floorId, 'f1');
  assert.equal(closed.floor.statusText, '今日休息');
  assert.equal(diningView([{ ...canteen, floors: [] }], override, {}, 700, null, 'c1').wholeDayRest, false);
  assert.equal(diningView([canteen], null, {}, 700, null, 'c1').floor.statusText, '');
});

test('located campus first, merchant closure, floor photos and nearby open canteen', () => {
  const merchant = { id: 'm1', name: '商家', businessType: '快餐', openingHours: '全天', phone: '123', stallCode: '', avgPrice: '', media: [], menu: [] };
  const first = { ...canteen, floors: [{ ...floor, merchants: [merchant] }] };
  const nearby = { ...canteen, placeId: 'c2', floors: [{ ...floor, floorId: 'f2' }] };
  const third = { ...canteen, placeId: 'c3', campusKey: 'jiading' };
  const result = diningView([first, nearby, third], { ...schedule, arrangement: { scheduleId: 's', floors: [{ floorId: 'f2', noBreakfast: false }] } }, { m1: 'temporarily_closed' }, 700, 'jiading', 'c1');
  assert.equal(result.groups[0].key, 'jiading');
  assert.equal(result.floor.merchants[0].closed, true);
  assert.deepEqual(result.alternatives.map(c => c.placeId), ['c2']);
});

function mount(detail = false) {
  const page = diningPage(detail);
  page.data = structuredClone(page.data);
  page.setData = function(data) { Object.assign(this.data, data); };
  page.onLoad({});
  page.visible = true;
  page.canteens = [canteen];
  return page;
}

test('live requests fail independently and never invent floor status', async () => {
  globalThis.wx = {
    getWindowInfo: () => ({}), getStorageSync: () => '',
    cloud: { callContainer(options) {
      if (options.path.startsWith('/api/public/dining/schedule')) options.fail({ errMsg: 'offline' });
      else options.success({ statusCode: 200, data: { statuses: { m1: 'temporarily_closed' } } });
    } },
  };
  const page = mount();
  await page.refreshLive();
  assert.match(page.data.scheduleError, /加载失败/);
  assert.equal(page.data.groups[0].canteens[0].floors[0].statusText, '');
  assert.equal(page.statuses.m1, 'temporarily_closed');
  assert.equal(page.data.noArrangement, false);
});

test('hidden page ignores late live responses and midnight clears yesterday while waiting', async () => {
  const pending = [];
  globalThis.wx.cloud.callContainer = options => pending.push(options);
  const page = mount();
  page.schedule = { ...schedule, date: '2000-01-01' };
  const work = page.refreshLive();
  assert.equal(page.schedule, null);
  page.onHide();
  for (const request of pending) request.success({ statusCode: 200, data: request.path.includes('dining') ? schedule : { statuses: {} } });
  await work;
  assert.equal(page.schedule, null);
});
