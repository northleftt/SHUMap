# SHUMap

SHUMap 是一个面向上海大学的移动端校园地图原型项目，当前重点覆盖：

- 校区地图浏览与 POI 搜索
- 楼宇筛选与详情查看
- 跨校区校车时刻查询

项目目前基于 `Vite + React + TypeScript` 开发，并保留了设计稿、地图源文件、校车资料和数据处理脚本，方便继续迭代。

## 当前功能

### 1. 地图页

- 支持宝山、嘉定、延长三个校区切换
- 直接读取 SVG 校园地图
- 支持关键词搜索与分类筛选
- 支持查看建筑详情
- 已为部分楼宇准备高德导航坐标

### 2. 校车页

- 支持选择出发校区和到达校区
- 根据日期自动切换工作日、周末、寒暑假时刻表
- 当天会优先显示最近一班和后续班次

### 3. 其他页面

- `校外`
- `我的`

这两个入口目前还是占位页，后续可以继续接功能。

## 技术栈

- React 19
- React Router 7
- TypeScript
- Vite
- Tailwind CSS 4
- Playwright
- Python 脚本（用于楼宇数据提取和地理编码）

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

默认会启动本地 Vite 开发服务器。

### 生产构建

```bash
npm run build
```

### 本地预览构建结果

```bash
npm run preview
```

## 常用脚本

### 坐标拾取

用 Playwright 辅助人工补齐或修正楼宇坐标：

```bash
npm run pick:coords
```

它对应的脚本是 [scripts/pick_coords_playwright.js](/Users/wangyixuan/SHUMap/scripts/pick_coords_playwright.js)。

### 高德地理编码

批量给楼宇数据补坐标：

```bash
python3 scripts/geocode_buildings.py
```

如果需要使用高德 Web Service Key，可以在 [`.env.local`](/Users/wangyixuan/SHUMap/.env.local) 中设置：

```bash
AMAP_API_KEY=your_key_here
```

脚本也会读取 [AMAP_API_KEY.env.local](/Users/wangyixuan/SHUMap/AMAP_API_KEY.env.local)。

### 从地图素材提取楼宇数据

```bash
python3 scripts/extract_buildings_from_svg.py
```

## 项目结构

```text
SHUMap/
├── src/                     前端源码
│   ├── components/          地图底部面板、地图画布、底部导航
│   ├── pages/               地图页、校车页、占位页
│   ├── lib/                 地图数据、布局工具、类型定义
│   └── utils/               校车时刻表处理逻辑
├── data/                    楼宇数据、校车时刻表数据
├── scripts/                 数据处理与辅助脚本
├── 地图/                    校园地图 SVG/AI 源文件
├── 前端设计稿/              设计稿与导出素材
├── 校车时刻表/              校车相关 PDF 和照片资料
└── README.md
```

## 重要文件

- [src/App.tsx](/Users/wangyixuan/SHUMap/src/App.tsx)：应用路由入口
- [src/pages/MapPage.tsx](/Users/wangyixuan/SHUMap/src/pages/MapPage.tsx)：校园地图主页面
- [src/pages/ShuttlePage.tsx](/Users/wangyixuan/SHUMap/src/pages/ShuttlePage.tsx)：校车时刻页
- [src/lib/mapData.ts](/Users/wangyixuan/SHUMap/src/lib/mapData.ts)：校区配置、筛选项、楼宇数据组装
- [src/utils/shuttle.ts](/Users/wangyixuan/SHUMap/src/utils/shuttle.ts)：校车路线和时刻表查询逻辑

## Git 使用

这个项目已经是一个独立 Git 仓库，并且已经连接了 GitHub 远程仓库。

平时最常用的流程：

```bash
git status
git add .
git commit -m "feat: describe your change"
git push
```

如果你不想一次提交所有文件，也可以只 `git add` 具体文件。

## 备注

- 仓库里保留了设计素材和参考资料，适合继续做原型迭代
- 当前更偏移动端交互体验
- `README` 会随着功能继续补充
