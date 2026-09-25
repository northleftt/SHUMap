import { floorView } from "../../lib/dining/view";
import { diningFacilities, ungroupedMerchants } from "../../lib/dining/facilities";
import { fetchDiningSchedule, fetchMerchantStatuses, fetchFacilityStatuses } from "../../lib/dining/live";
import { shanghaiMinutes, shanghaiToday } from "../../lib/dining/schedule";
import { facilityIconName } from "../../lib/map/poiIcons";
Component({
  properties: { canteen: Object, merchants: Array, facilities: Array, placeId: String },
  data: { floors: [], others: [], facilityRows: [], noArrangement: false, scheduleError: "", merchantError: "", facilityError: "" },
  observers: { "canteen,merchants,facilities": function() { if (this.initialized) this.render(); } },
  lifetimes: {
    attached() { this.initialized = true; this.schedule = null; this.statuses = {}; this.facilityStatuses = null; this.generation = 0; this.start(); },
    detached() { this.stop(); },
  },
  pageLifetimes: { show() { if (this.initialized) this.start(); }, hide() { this.stop(); } },
  methods: {
    start() { this.stop(); this.visible = true; this.render(); void this.refresh(); this.timer = setInterval(() => { this.render(); void this.refresh(); }, 30000); },
    stop() { this.visible = false; this.generation++; clearInterval(this.timer); },
    async refresh() {
      const generation = ++this.generation;
      const current = () => this.visible && generation === this.generation;
      await Promise.all([
        fetchDiningSchedule().then(value => { if (current()) { this.schedule = value; this.setData({ scheduleError: "" }); this.render(); } }).catch(() => { if (current()) { this.schedule = null; this.setData({ scheduleError: "就餐安排加载失败，点击重试" }); this.render(); } }),
        fetchMerchantStatuses().then(value => { if (current()) { this.statuses = value.statuses; this.setData({ merchantError: "" }); this.render(); } }).catch(() => { if (current()) { this.statuses = {}; this.setData({ merchantError: "商家状态加载失败，点击重试" }); this.render(); } }),
        fetchFacilityStatuses().then(value => { if (current()) { this.facilityStatuses = value; this.setData({ facilityError: "" }); this.render(); } }).catch(() => { if (current()) { this.facilityStatuses = null; this.setData({ facilityError: "设施状态加载失败，点击重试" }); this.render(); } }),
      ]);
    },
    retry() { void this.refresh(); },
    render() {
      if (this.schedule?.date !== shanghaiToday()) this.schedule = null;
      const c = this.data.canteen;
      const floors = c?.floors || [];
      const noArrangement = Boolean(this.schedule && this.schedule.dayType !== "weekday" && !this.schedule.arrangement);
      const rows = c ? floors.map((floor: any) => ({ ...floorView(c, floor, this.schedule, this.statuses || {}, shanghaiMinutes()), ...(noArrangement && !c.closed ? { statusText: "" } : {}) })) : [];
      this.setData({ floors: rows, noArrangement,
        others: ungroupedMerchants(this.data.merchants || [], floors).map((m: any) => ({ ...m, closed: this.statuses?.[m.id] === "temporarily_closed" })),
        facilityRows: diningFacilities(this.data.facilities || [], floors, this.facilityStatuses).map(row => ({ ...row, icon: facilityIconName(row.typeCode) })),
      }, () => this.triggerEvent("resize"));
    },
    openFloor(e: any) { const floor = e.currentTarget.dataset.floor; wx.navigateTo({ url: `/pages/dining/dining?placeId=${encodeURIComponent(this.data.placeId)}${floor ? `&floor=${encodeURIComponent(floor)}` : ""}` }); },
    openMerchant(e: any) { this.triggerEvent("merchant", { id: e.currentTarget.dataset.id }); },
    openFacilities() { wx.navigateTo({ url: `/pages/floors/floors?placeId=${encodeURIComponent(this.data.placeId)}&floor=all` }); },
  },
});
