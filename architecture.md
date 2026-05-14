# SerialPlotter 代码架构文档

## 1 项目概述

SerialPlotter 是一个基于 Web 的串口/网络数据科学绘图工具，由纯前端 HTML + CSS + JavaScript 构成（网络模式辅以 Node.js WebSocket Bridge）。支持实时 FFT 频谱分析、多通道波形监视、自定义帧解析与 CSV 导出。

## 2 技术栈

| 层次 | 技术 |
|---|---|
| 页面结构 | HTML5 |
| 样式 | 原生 CSS3（CSS Variables） |
| 绘图引擎 | Canvas 2D API（原生手写 FFT） |
| 串口通信 | Web Serial API（Chromium） |
| 网络通信 | WebSocket + Node.js `ws` / `net` / `dgram` |
| 运行时 | 浏览器（前端）；Node.js 14+（Bridge） |

## 3 文件结构与职责

```
self_serialplot/
├── index.html          # 页面入口，DOM 结构与 UI 布局
├── styles.css          # 全局样式（布局、配色、组件）
├── plotter.js          # 波形绘图引擎（Canvas 渲染 + FFT + 交互）
├── dataParser.js       # 二进制帧解析器（帧头/帧尾/校验/多数据类型）
├── serialEngine.js     # 串口通信适配器（Web Serial API）
├── netEngine.js        # 网络通信适配器（WebSocket 客户端）
├── app.js              # 应用主控制器（业务逻辑、事件绑定、配置管理）
├── bridge.js           # Node.js WebSocket-to-TCP/UDP 桥接服务
├── package.json        # Node.js 项目描述（bridge.js 依赖）
├── serial_config.json  # 示例配置文件
├── web_socket_test.html# WebSocket 测试页面
└── readme.md           # 项目文档
```

## 4 整体架构

系统采用**分层 + 适配器**模式，数据流方向如下：

```
┌─────────────────────────────────────────────────────────────────┐
│                         浏览器前端                               │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌────────────┐             │
│  │  index   │───▶│    app.js    │───▶│  plotter   │  Canvas 渲染 │
│  │  .html   │    │ (主控制器)    │    │   .js      │              │
│  └──────────┘    └──────┬───────┘    └────────────┘             │
│                         │                                       │
│              ┌──────────┼──────────┐                            │
│              ▼          ▼          ▼                            │
│        ┌──────────┐ ┌────────┐ ┌──────────┐                    │
│        │ serial   │ │  net   │ │  data    │                     │
│        │ Engine   │ │ Engine │ │  Parser  │                     │
│        └────┬─────┘ └───┬────┘ └──────────┘                     │
│             │           │                                       │
└─────────────┼───────────┼───────────────────────────────────────┘
              │           │
         Web Serial    WebSocket
              │           │
              ▼           ▼
         串口设备    ┌──────────┐
                    │ bridge.js│  Node.js 进程
                    │ (WS→TCP/ │
                    │  UDP)    │
                    └────┬─────┘
                         │
                    TCP / UDP 网络
```

## 5 各模块详细设计

### 5.1 `index.html` — 页面结构

页面采用**左右分栏**布局：

- **左侧边栏 (`aside.sidebar`)**：包含三个 Tab 页
  - **通讯**：连接模式选择（Serial / TCP Client / TCP Server / UDP）、串口参数、网络参数、配置导入导出
  - **帧格式**：帧头/帧尾特征匹配、校验位、数据类型、字节端序、通道数
  - **通道**：通道显示配置（名称、颜色、可见性）、波形模式（时域/频域）、Y 轴策略、最大采样点数、CSV 导出

- **右侧主区域 (`main.main-display`)**：
  - **波形监视台 (`canvas-wrapper`)**：Canvas 绘图区 + 统计信息栏 + 滚动条
  - **字节流监视台 (`monitor-panel`)**：RX/TX 速率统计 + 日志面板 + 发送面板（Hex/Text、定时发送、文件载入）

- **可拖拽分隔条**：水平（侧栏宽度）、垂直（绘图区/监视台高度）

脚本加载顺序：`plotter.js` → `dataParser.js` → `serialEngine.js` → `netEngine.js` → `app.js`

### 5.2 `plotter.js` — 波形绘图引擎 (`Plotter` 类)

核心职责：Canvas 2D 波形渲染、FFT 频谱计算、用户交互。

| 功能 | 说明 |
|---|---|
| 多通道管理 | `channels[]` 数组，每个通道含 `data[]`、`color`、`visible`、`name` |
| 时域绘制 | 逐点连线 + 散点，自动/手动 Y 轴缩放 |
| 频域绘制 | 内置 Cooley-Tukey FFT（`_fftInPlace`），Hamming 窗函数，可选去直流 |
| 视口滚动 | `scrollOffset` + `displayCount`，支持自动跟随最新数据 |
| 鼠标缩放 | 滚轮以鼠标位置为中心缩放显示窗口 |
| 十字光标 | `mousemove` 追踪，显示坐标 + 各通道交点值（防重叠标签布局） |
| 统计信息 | 单通道时计算最大/最小/峰峰/均值/标准差/主频/主周期，通过 `onStatsUpdate` 回调 |
| 滚动条 | DOM 元素实现，支持拖拽和点击跳转 |
| CSV 导出 | `exportCSV()` 导出全部通道数据 |
| 渲染循环 | `requestAnimationFrame` 驱动，非暂停时持续绘制 |

**关键属性**：

```javascript
this.displayMode    // 'time' | 'frequency'
this.yScaleMode     // 'auto' | 'manual'
this.removeDcForFft // 频域去直流开关
this.maxPoints      // 每通道最大缓存点数
this.displayCount   // 当前视口显示点数
this.scrollOffset   // 视口起始偏移
this.autoFollow     // 是否自动跟随最新数据
```

### 5.3 `dataParser.js` — 帧解析器 (`DataParser` 类)

核心职责：将原始字节流解析为结构化数据帧。

**帧格式**：

```
[可选帧头] + [数据负载] + [可选帧尾] + [可选校验和]
```

**解析流程**：

1. `appendData(newData)` — 追加原始字节到内部缓冲区，触发 `onRawData` 回调
2. `processBuffer()` — 循环扫描缓冲区：
   - 匹配帧头（滑动窗口搜索）
   - 校验帧尾
   - 校验 8-bit 和校验
   - 解析数据负载 → `onFrameParsed(values[], timeStr, hexStr)`
   - 校验失败 → `onFrameError(type, timeStr, hexStr)`

**支持的数据类型**：int8/uint8, int16/uint16, int32/uint32, int64/uint64, float32/float64

**回调接口**：

```javascript
onRawData(hexStr, timeStr)           // 每次收到原始数据块
onFrameParsed(values[], timeStr, hexStr)  // 成功解析一帧
onFrameError(type, timeStr, hexStr)  // 帧校验失败 ('checksum' | 'footer')
```

### 5.4 `serialEngine.js` — 串口适配器 (`SerialEngine` 类)

核心职责：封装 Web Serial API，提供统一的连接/断开/收发接口。

```javascript
connect(config)     // 请求用户选择串口并打开，参数：baudRate, dataBits, stopBits, parity
disconnect()        // 关闭串口
send(data)          // 发送 Uint8Array
onData(callback)    // 注册数据接收回调
onStatusChange(cb)  // 注册连接状态变化回调
```

内部维护 `readLoop()` 持续读取串口数据流。监听 `navigator.serial` 的 `disconnect` 事件处理设备意外拔出。

### 5.5 `netEngine.js` — 网络适配器 (`NetEngine` 类)

核心职责：通过本地 WebSocket 连接 `bridge.js`，间接实现 TCP/UDP 通信。

```javascript
connect(config)     // 连接 ws://127.0.0.1:8081，发送 JSON 命令建立 TCP/UDP 通道
disconnect()        // 断开 WebSocket
send(data)          // 发送二进制数据（通过 JSON 包装为 bridge 命令）
onData(callback)    // 注册数据接收回调
onStatusChange(cb)  // 注册连接状态变化回调
```

与 bridge.js 的协议：
- 文本消息：JSON 控制命令（`{cmd: 'connect', mode, host, port}` / `{cmd: 'disconnect'}`）
- 二进制消息：透传的数据帧

### 5.6 `bridge.js` — WebSocket-to-TCP/UDP 桥接服务

Node.js 进程，监听 `ws://0.0.0.0:8081`，为浏览器提供 TCP/UDP 能力。

| 模式 | 实现 |
|---|---|
| TCP Client | `net.Socket.connect(host, port)`，双向透传 |
| TCP Server | `net.createServer()`，单客户端模式（新连接挤掉旧连接） |
| UDP | `dgram.createSocket('udp4')`，绑定本地端口接收，发送到指定远端地址 |

数据流：浏览器 WebSocket ↔ bridge.js ↔ TCP/UDP Socket

### 5.7 `app.js` — 应用主控制器

核心职责：**粘合层**，将所有模块连接起来，处理 UI 事件和业务逻辑。

**初始化**：

```javascript
const serialAdapter = new SerialEngine();
const netAdapter    = new NetEngine();
const parser        = new DataParser();
const plotter       = new Plotter('waveform-canvas');
```

**数据路由**：

```javascript
// 所有数据源 → 解析器
serialAdapter.onData(data => parser.appendData(data));
netAdapter.onData(data => parser.appendData(data));

// 解析器回调 → 绘图器 + 监视台
parser.onRawData   = (hex, time) => { /* 更新 RX 统计 */ };
parser.onFrameParsed = (vals, time, hex) => { plotter.addFrame(vals); /* 日志 */ };
parser.onFrameError  = (type, time, hex) => { /* 错误日志 */ };
```

**主要功能模块**：

| 功能 | 说明 |
|---|---|
| Tab 切换 | 通讯/帧格式/通道三个标签页 |
| 连接管理 | 根据 `conn-type` 选择 serial 或 net 引擎 |
| 帧格式应用 | 将 UI 配置传给 `parser.setFormat()` 和 `plotter.setChannelCount()` |
| 通道配置 UI | 动态生成通道行（颜色选择器、名称输入、可见性复选框） |
| 配置持久化 | `localStorage` 自动保存，支持 JSON 文件导入导出 |
| 统计计算 | 1 秒周期计算 RX/TX 速率、帧率、校验失败率 |
| 发送面板 | Hex/Text 模式切换、定时发送（ms/s/Hz）、文件载入 |
| 分隔条拖拽 | 水平/垂直可拖拽分隔条调整布局 |
| 日志管理 | 最多 120 条，自动滚动，颜色区分 RX/TX/成功/失败 |

### 5.8 `styles.css` — 样式系统

- 使用 CSS Variables 定义主题色（`--primary`, `--danger`, `--success` 等）
- 左右分栏 Flexbox 布局，`100vw × 100vh` 全屏
- 侧栏固定宽度（268px），通过 JS 动态调整
- 深色主题用于绘图区和监视台（`#111` 背景）
- 自定义滚动条样式（5px 宽）
- 响应式通道配置列表

## 6 核心数据流

```
串口/网络设备
    │
    ▼
SerialEngine / NetEngine.onData(Uint8Array)
    │
    ▼
DataParser.appendData(Uint8Array)
    ├── onRawData(hexStr, timeStr)        → 更新 RX 字节统计
    └── processBuffer()
        ├── onFrameParsed(values[], ...)  → Plotter.addFrame() + 监视台日志
        └── onFrameError(type, ...)       → 监视台错误日志
                                            │
                                            ▼
                                      Plotter.draw()
                                      ├── 时域：逐点连线
                                      └── 频域：FFT → 幅度谱
```

## 7 配置管理

配置通过 `localStorage`（key: `serialplot_v3_config`）自动持久化，同时支持 JSON 文件导入导出。

配置项涵盖：连接参数、帧格式、通道元数据（名称/颜色/可见性）、绘图显示选项。

## 8 外部依赖

| 依赖 | 用途 | 运行环境 |
|---|---|---|
| `ws` ^8.16.0 | WebSocket 服务端 | Node.js (bridge.js) |
| Web Serial API | 串口通信 | Chromium 浏览器 |
| Canvas 2D API | 波形渲染 | 浏览器 |
| Inter 字体 | UI 字体 | 浏览器 (Google Fonts CDN) |

## 9 模块依赖关系

```
index.html
  ├── styles.css
  ├── plotter.js      (独立，无外部依赖)
  ├── dataParser.js   (独立，无外部依赖)
  ├── serialEngine.js (独立，依赖 Web Serial API)
  ├── netEngine.js    (独立，依赖 WebSocket API)
  └── app.js          (依赖以上所有模块)

bridge.js             (独立 Node.js 进程，依赖 ws 包)
```

各 JS 模块之间**无直接 import/export**，通过全局类名暴露，在 `app.js` 中实例化并组装。
