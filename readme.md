# SerialPlotter

网页端实时数据可视化分析工具，支持串口、TCP 和 UDP 数据流的解析、监视与波形展示。

![License](https://img.shields.io/badge/License-CC%20BY%20NC%20SA%204.0-blue.svg)![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-yellow.svg)![Platform](https://img.shields.io/badge/platform-Web-green.svg)

## 1 项目简介

SerialPlotter 是一个无需后端框架的浏览器端工具，适合调试单片机、传感器、上位机协议和网络数据流。它可以把接收到的数据实时绘制成波形，支持时域、频域、通道配色、统计信息、发送面板和配置导入导出。

## 2 主要功能

- 串口通信：基于 Web Serial API，适合现代 Chromium 系浏览器。
- 网络通信：通过本地 `bridge.js` 提供 TCP Client、TCP Server 和 UDP 能力。
- 波形显示：支持时域图和频域图切换，频域模式内置 FFT。
- 频域去直流：可选在 FFT 前移除 DC 分量。
- 多通道显示：支持自定义通道名、颜色、显示/隐藏。
- 统计信息：单通道时显示最大值、最小值、峰峰值、均值、标准差、主频和周期。
- 交互查看：支持十字光标、滚动查看、鼠标缩放、手动 Y 轴范围。
- 帧解析：支持头部、尾部、8-bit 校验、字节序和多种数据类型。
- 发送面板：支持 Hex/Text、文件发送、定时发送。
- 配置管理：支持本地保存、导入、导出。

## 3 环境要求

### 3.1 浏览器

建议使用 Chrome 或 Edge 等 Chromium 内核浏览器。

- 需要支持 Web Serial API 才能使用串口模式。
- 建议通过本地 HTTP 服务或 HTTPS 方式打开页面，不要只依赖 `file://`。
- Firefox、Safari 目前不适合本项目的串口模式。

### 3.2 Node.js

如果需要使用 TCP/UDP 模式，请安装：

- Node.js 14 或更高版本
- npm 6 或更高版本

## 4 运行方式

### 4.1 网络访问（体验与试用）

适合初次尝试使用，直接访问 https://yssickjgd.github.io/serial_plotter/ 即可。

### 4.2 本地访问（强烈推荐）

如若希望长期离线使用，则可以将仓库下载到本地：

```bash
git clone https://github.com/yssickjgd/serial_plotter
```

然后，在浏览器中打开仓库内的 `index.html` 即可。

### 4.2 启用 TCP/UDP 网络功能

本项目还支持网络数据流的监听、解析、通信、绘图.如若使用该功能，则须克隆该仓库到本地：

```bash
git clone https://github.com/yssickjgd/serial_plotter
```

而后，需要在该仓库内执行下述两条命令，开启服务。注意！使用期间不能关闭该界面：

```bash
npm install
npm start
```

默认会启动本地 WebSocket Bridge，监听 `ws://127.0.0.1:8081`。此时，可配置网络监听环境

## 5 使用方法

### 5.1 串口模式

1. 打开左侧“通讯”选项卡。
2. 选择“原生串口 (Web Serial)”模式。
3. 设置波特率、数据位、停止位和校验位。
4. 点击“连接”，在浏览器弹窗中选择串口设备。
5. 接收数据后可在下方“字节流监视台”和上方“波形监视台”看到内容。

### 5.2 TCP Client 模式

1. 启动 `node bridge.js`。
2. 在“通讯”里选择 “TCP Client (Bridge)”。
3. 填写远端 TCP Server 的 Host 和 Port。
4. 点击“连接”。

### 5.3 TCP Server 模式

1. 启动 `node bridge.js`。
2. 选择 “TCP Server (Bridge)”。
3. 填写要监听的本地端口。
4. Host 字段可以忽略，桥会在 `0.0.0.0` 上监听该端口。
5. 让外部 TCP 客户端连接这个端口即可。

### 5.4 UDP 模式

1. 启动 `node bridge.js`。
2. 选择 “UDP (Bridge)”。
3. 填写远端 Host 和 Port，这表示发送目标。
4. 填写本地监听端口，用于接收 UDP 数据。
5. 如果本地端口留空，程序会优先使用 Port 作为默认监听端口。

## 6 界面说明

### 6.1 波形监视台

- 时域图：显示原始采样值。
- 频域图：显示 FFT 频谱。
- 单通道时会显示统计信息。
- 统计栏会使用通道自定义名称，而不是默认 CH1、CH2。

### 6.2 字节流监视台

日志颜色统一如下：

- 蓝色：接收成功 `RX`
- 黄色：接收错误 `RX[原因]`
- 绿色：发送成功 `TX`
- 红色：发送错误 `TX[原因]`

说明：

- 未通过验证的数据会显示时间戳。
- 错误原因会直接附在 `RX` 或 `TX` 后面。
- 接收速率按真实接收到的数据块统计，不会因为错误帧重复放大。

## 7 配置文件

配置支持导入导出，格式为 JSON。示例：

```json
{
  "connType": "serial",
  "serialBaud": "115200",
  "serialData": "8",
  "serialStop": "1",
  "serialParity": "none",
  "netHost": "127.0.0.1",
  "netPort": "8081",
  "netLocalPort": "9000",
  "enableHeader": false,
  "headerHex": "AB",
  "enableFooter": true,
  "footerHex": "0D 0A",
  "enableChecksum": false,
  "dataType": "float32",
  "endianness": "little",
  "channelsCount": "4",
  "maxPoints": "1000",
  "sendIntervalUnit": "ms",
  "plotViewMode": "time",
  "plotYScaleMode": "auto",
  "plotFftRemoveDc": false,
  "plotYMin": "-1",
  "plotYMax": "1",
  "channels": [
    { "name": "acc_x", "color": "#ff0000", "visible": true },
    { "name": "acc_y", "color": "#00ff00", "visible": true }
  ]
}
```

支持的数据类型：

| 类型 | 字节数 |
|---|---:|
| int8 / uint8 | 1 |
| int16 / uint16 | 2 |
| int32 / uint32 / float32 | 4 |
| int64 / uint64 / float64 | 8 |

## 8 帧格式说明

基本结构如下：

```text
[可选头部] + [数据负载] + [可选尾部] + [可选校验]
```

示例：

```text
[AB] + [payload] + [0D 0A]
```

如果启用了校验位，校验值位于帧尾之后。

## 9 常见问题

### 9.1 串口无法连接

- 确认浏览器是否支持 Web Serial API。
- 确认页面是否通过本地 HTTP 服务或 HTTPS 打开。
- 检查串口是否已被其它程序占用。

### 9.2 TCP/UDP 无法监听

- 确认已经运行 `npm start`。
- TCP Server 模式下，请填写要监听的本地端口。
- UDP 模式下，请填写本地监听端口；远端 Host/Port 只是发送目标。
- 如果是 TCP Server，请确认该端口未被其它程序占用。
- 注意！目前暂不支持打开两个网页分别作为 Client 和 Server 这种特殊的工作模式。

### 9.3 波形不显示

- 在“通道”页勾选需要显示的通道。
- 检查 Y 轴范围是否合适。
- 切换到自动 Y 轴缩放试试。

### 9.4 发送定时任务异常

- 如果连接断开，程序会自动停止定时发送。
- 出错信息会出现在字节流监视台，不会再弹出浏览器提示框。

## 10 项目结构

```text
serialplot_new_test/
├── app.js
├── bridge.js
├── dataParser.js
├── index.html
├── netEngine.js
├── package.json
├── plotter.js
├── readme.md
├── serialEngine.js
├── serial_config.json
├── styles.css
└── web_socket_test.html
```

## 11 开源说明

本仓库遵循 CC-BY-NC-SA 4.0 开源协议。

## 12 贡献

欢迎提交 Issue 和 Pull Request。

建议在提交问题时附带：

- 浏览器版本
- 操作系统
- 连接模式（Serial / TCP Client / TCP Server / UDP）
- 相关配置文件
- 复现步骤或截图

##13 相关资源

- Web Serial API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- Canvas API: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
- FFT: https://en.wikipedia.org/wiki/Fast_Fourier_transform

最后更新：2026-05-01

