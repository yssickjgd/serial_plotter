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
| `frameBuffer.js` | 同步保存各通道数值与原始帧的有界环形缓冲区 |
| `plotMath.js` | 像素分桶极值与 CSV 字段转义 |
| `csvExport.js` | 从完整保留窗口生成 CSV |
| `spectrum.js` | Hann 窗、FFT 与幅度谱计算 |
| `plotter.js` | Canvas、通道显示、视口交互与频谱缓存；读取应用提供的缓冲区 |
| `monitorView.js` | 原始帧和 TX/错误事件的可视区域日志 |
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

`DataParser` 的回调参数为 `(values, time, frameBytes)`、`(type, time, frameBytes)` 和 `(chunkBytes, time)`。监视台按可用宽度计算每条记录的行高与虚拟滚动位置，原始字节在记录进入可见区域时才转为 Hex 文本。暂停时入口丢弃新字节，已保留的样本和原始帧仍可滚动查看。导出 CSV 使用窗口内完整样本，而非屏幕上的抽样折线。

时域视口和频域视口的滚动状态独立；两者的手动 Y 轴范围也独立。FFT 仅计算可见通道，采集中至多约每 250 ms 更新一次，设置改变或暂停后立即刷新。

绘图区的 Pointer 事件管理矩形框选。`plotMath.js` 将画布矩形映射到当前可见样本与 Y 值范围；`Plotter` 为时域和频域分别保存临时框选视口。框选不会改写持久化的 Y 轴配置，右键清除当前模式的框选范围。

## 配置与测试

配置仍保存在 `localStorage` 的 `serialplot_v3_config`，导入导出字段维持原格式，并接受旧版 `plotYMin` / `plotYMax`。通道数为 1–24，最大采样点数为 2–100000。

在 Node.js 24 环境运行 `npm run check` 检查 JavaScript 语法和空白格式，运行 `npm test` 覆盖解析、缓冲、网络、配置恢复、发送、脚本加载和 30 万帧压力场景。浏览器绘制频率和交互延迟需要在目标 Windows Chrome/Edge 环境中测量。
