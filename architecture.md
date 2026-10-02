# SerialPlotter 架构

## 运行方式

`index.html` 按顺序加载经典 JavaScript 脚本，可直接在支持 Web Serial 的 Chromium 浏览器中打开，不需要前端构建。TCP/UDP 通信需要先运行 `npm install` 和 `npm start`。WebSocket Bridge 默认仅在 `127.0.0.1:8081` 接受页面连接；TCP Server 和 UDP 的设备监听端口可由页面配置。

浏览器模块通过 `globalThis.SerialPlotter` 暴露接口；`index.html` 定义加载顺序。Node 测试通过 CommonJS 导出或按页面顺序加载脚本。Bridge 独立运行，不依赖页面模块。

## 模块职责

| 文件 | 职责 |
|---|---|
| `serialEngine.js` | Web Serial 连接、读取、发送和断开 |
| `netEngine.js` | WebSocket 客户端和桥接状态；数据消息为二进制 |
| `bridge.js` | 本地 WebSocket 与 TCP/UDP 之间的双向转发 |
| `dataParser.js` | 按帧格式解析连续字节流，按需复制完整原始帧 |
| `projectLimits.js`、`byteUtils.js` | 共享的数值范围与字节转换 |
| `frameBuffer.js` | 按需分块的有界环形缓冲区，同步保存数值、原始字节和接收时间 |
| `plotMath.js` | 像素分桶极值与 CSV 字段转义 |
| `channelTransform.js` | 通道放大与偏移的统一数值变换 |
| `csvExport.js` | 从完整保留窗口生成 CSV，大容量数据可分批写入文件 |
| `spectrum.js` | 可选窗函数、FFT 与幅度谱计算 |
| `plotter.js` | Canvas、通道显示、视口交互与频谱缓存；读取应用提供的缓冲区 |
| `monitorView.js` | 原始帧和 TX/错误事件的可视区域日志 |
| `monitorSearch.js` | 跨帧字节搜索和解码通道值搜索，分批扫描保留窗口 |
| `configValidation.js` | 导入配置和 UI 数值校验 |
| `configView.js`、`configStore.js` | 配置表单映射、恢复与持久化 |
| `sendController.js` | 发送面板、文件原始字节和定时发送 |
| `app.js` | UI 事件、通信与数据组件的装配 |

## 数据链路

```text
Web Serial / WebSocket 二进制帧
  → DataParser（分块缓冲、帧头/帧尾/校验和）
  → FrameBuffer（应用持有；全部有效样本及原始字节，按最大点数淘汰）
  → Plotter / MonitorView / CSV 导出（共享同一窗口）
```

`DataParser` 的有效帧回调参数为 `(values, time, frameBytes, timestamp)`，其中 `timestamp` 为系统时间毫秒值。监视台仅渲染可见行；大容量时将记录索引映射到有界的浏览器滚动高度。原始字节仅在可见或搜索时读取，显示可选 Hex、ASCII 或解码数值。暂停时入口丢弃新字节，已保留的样本和原始帧仍可滚动查看。通道变换在读取时应用于绘图、频谱、统计和 CSV；缓冲区及监视台保留原始值和字节。

时域视口和频域视口的滚动状态独立；两者的手动 Y 轴范围也独立。FFT 仅计算可见通道，采集中最短每 100 ms 更新一次；仅有新采样且缓存尚未到期时跳过重复绘图，设置改变或暂停后立即刷新。

绘图区的 Pointer 事件管理矩形框选。`plotMath.js` 将画布矩形映射到当前可见样本与 Y 值范围；`Plotter` 为时域和频域分别保存临时框选视口。框选不会改写持久化的 Y 轴配置，右键清除当前模式的框选范围。

## 配置与测试

配置仍保存在 `localStorage` 的 `serialplot_v3_config`，现有字段取值保持兼容，并新增 `plotWindowPoints`、`plotFftWindow` 及每通道的 `gainEnabled`、`gain`、`offsetEnabled`、`offset`。旧配置默认使用 Hann 窗、1000 点波形窗口且关闭通道变换，也接受旧版 `plotYMin` / `plotYMax`。通道数为 1–50，最大采样点数为 2–3600000，波形窗口为 2–65536 且不能超过最大采样点数。

在 Node.js 24 环境运行 `npm run check` 检查 JavaScript 语法和空白格式，运行 `npm test` 覆盖解析、缓冲、网络、配置恢复、发送、脚本加载和 30 万帧压力场景。浏览器绘制频率和交互延迟需要在目标 Windows Chrome/Edge 环境中测量。
