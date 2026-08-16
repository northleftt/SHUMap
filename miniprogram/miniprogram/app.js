// app.js
const { config } = require("./config.js");

App({
  onLaunch: function () {
    this.globalData = {
      // 云开发环境 ID（真机/上线的云托管代理走这里），统一在 config.ts 的 cloudEnv 维护。
      env: config.cloudEnv,
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        // cloudEnv 为空（本地调试、未走云托管）时不指定 env，避免 init 报错。
        env: config.cloudEnv || undefined,
        traceUser: true,
      });
    }
  },
});
