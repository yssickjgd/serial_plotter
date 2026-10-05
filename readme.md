# SerialPlotter

网页端实时数据可视化分析工具，支持串口、TCP 和 UDP 数据流的解析、监视与波形展示。

![License](https://img.shields.io/badge/License-CC%20BY%20NC%20SA%204.0-blue.svg)![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-yellow.svg)![Platform](https://img.shields.io/badge/platform-Web-green.svg)

## 1 项目简介

SerialPlotter 是一个无需后端框架的浏览器端工具，适合调试单片机、传感器、上位机协议和网络数据流。它可以把接收到的数据实时绘制成波形，支持时域、频域、通道配色、统计信息、发送面板和配置导入导出。

界面英文和数字沿用等宽字体，中文使用随项目附带的开源 Noto Sans SC。字体文件和独立授权说明位于 [`assets/fonts/`](assets/fonts/README.md)，离线打开页面也无需在线字体服务。

## 2 主要功能

- 串口通信：基于 Web Serial API，适合现代 Chromium 系浏览器。
- 网络通信：通过本地 `bridge.js` 提供 TCP Client、TCP Server 和 UDP 能力。
- 波形显示：支持时域图和频域图切换，频域模式内置 FFT。
- 频域去直流：可选在 FFT 前移除 DC 分量。
- 多通道显示：右侧通道面板支持名称、颜色、显示开关，以及逐通道放大系数和偏移量。
- 采样缓存最多保留 360 万帧、50 通道；波形监视台的默认可见窗口独立设置，最多 65536 点。缓存按需分配，实际内存随保留数据增长。
- 统计信息：波形监视台显示实际绘图帧率；单通道时还显示最大值、最小值、峰峰值、均值、标准差、主频和周期。
- 交互查看：支持十字光标、双轴拖动条、滚轮缩放、矩形框选放大和手动 Y 轴范围。
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

然后，在浏览器中打开仓库内的 `index.html` 即可。前端无需构建或安装依赖；TCP/UDP 模式仍需启动本地 Bridge。

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

默认会启动本地 WebSocket Bridge，仅监听 `ws://127.0.0.1:8081`。TCP Server 与 UDP 的设备监听端口仍按页面配置工作。

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

- 时域图：显示通道采样值；横轴可选采样点或秒（s）。
- 频域图：可选择无窗、Hann、Hamming、Blackman 或 Flat-top 窗，默认 Hann。FFT 前可选去直流，频谱按窗的相干增益校正为单边线性幅值。横轴可选 FFT 频点编号或 Hz，并可选线性或对数间距；纵轴可选线性幅值或对数间距的幅值（不是 dB）。对数横轴从第 1 个频点开始；对数纵轴的零幅值绘在显示下界，手动范围必须为正。
- 实时采集时，FFT 使用波形监视台窗口内的最新样本；暂停捕捉后，FFT 使用时域图当前 X 轴可见范围内的样本。暂停期间可切到时域图滚动或缩放，再切回频域图查看对应频谱；恢复捕捉后重新使用最新窗口。单通道频域统计也采用相同的数据范围。
- “最大采样点数”控制历史保留量，“波形监视台内采样点数”控制默认时域窗口与实时 FFT 输入，后者不能超过前者或 65536。减小保留量时窗口会自动缩小；时域图右键恢复最新窗口。
- 波形和字节流监视台的时间定位，以及字节流搜索，常驻显示在各自的标题与控件同行中，仅暂停捕捉时可操作。系统时间或相对秒数直接单选，时间输入以 10 ms 为步进；暂停时系统时间默认填入最新保留帧的时间，无数据帧时填入当前时间。相对时间从当前保留的最早采样帧开始计算；旧帧被淘汰后零点随之移动。字节流标题栏可临时隐藏波形监视台。
- 两个监视台使用一致的标题和统计栏，统计标签位置固定；控件在窄窗口按组换行。没有单通道统计时波形统计行自动收起，字节记录区至少保留四行。
- 显示方式使用直接可见的单选项；切换时域/频域后只显示该模式的设置，勾选自定义 Y 轴范围后才显示边界输入框。
- 右侧通道面板可拖动调整宽度。每个通道可分别启用放大和偏移，计算顺序为 `y = kx + b`；系数允许 0 和负数。变换值参与绘图、FFT、光标、统计和 CSV，原始字节记录不变。
- Hz 和 s 按最近测得的接收帧率换算；帧率尚未测得时显示 `-- Hz` 或 `-- s`。采样间隔稳定时，换算结果才较准确。
- 单通道时会显示统计信息。
- 波形监视台的“绘图帧率”在时域统计完成的画布重绘，在频域统计实际更新并呈现的新频谱，重复绘制缓存频谱不计入；字节流监视台的“帧率”统计接收帧数。暂停后无新绘制时前者为 `0 FPS`。
- 持续接收时，频谱最短每 100 ms 更新一次；仅有新采样而频谱尚未到期时不重复绘制缓存频谱。鼠标操作和显示设置变化仍可触发即时重绘。实际帧率取决于通道数、采样点数和设备性能。
- 统计栏会使用通道自定义名称，而不是默认 CH1、CH2。
- 在绘图区按住鼠标左键拖出矩形，松开后放大框内的横轴与纵轴范围；拖动过小不会触发缩放。时域和频域均可使用。
- 鼠标位于绘图区或下方 X 轴刻度带时，滚轮缩放横轴；位于右侧 Y 轴刻度带时，滚轮缩放纵轴。横轴放大后可拖动底部滚动条，纵轴放大后可拖动右侧滚动条。
- 实时采集时，横轴滚动条离开最右侧后固定当前样本窗口；新帧不会改变所选波形，直到该窗口的最早样本被缓冲区淘汰，才从左侧随旧帧淘汰而更新。拖回最右侧或右键恢复最新数据跟随。
- 在绘图区点击右键恢复完整横轴范围，并撤销框选或滚轮带来的纵轴缩放。原有的手动 Y 轴范围会恢复。

### 6.2 字节流监视台

日志颜色统一如下：

- 蓝色：接收成功 `RX`
- 黄色：接收错误 `RX[原因]`
- 绿色：发送成功 `TX`
- 红色：发送错误 `TX[原因]`

说明：

- 未通过验证的数据会显示时间戳。
- 错误原因会直接附在 `RX` 或 `TX` 后面。
- 较长的 Hex 记录会随监视台宽度自动换行，续行与第一行 Hex 字节的起始列对齐（普通记录为 `RX ` 或 `TX ` 后）。
- 在底部自动跟随最新记录；向上滚动后固定所查看的记录，滚回底部恢复跟随。记录超出保留窗口后会显示当前最早的记录。
- 接收显示格式直接单选 Hex、ASCII 或当前帧格式解码后的原始通道数值。ASCII 的不可打印字节显示为 `·`；通道数值不应用显示变换。发送框显示格式可单选 Hex/Text，发送间隔单位可单选 ms/s/Hz。
- 暂停捕捉后可单选十六进制字节、ASCII 文本（都可跨帧匹配）或指定误差范围内的解码通道数值进行搜索。点击日志行可设置搜索光标；“上一个”“下一个”“光标就近”定位结果。所有当前可见的匹配会高亮，当前结果使用另一种颜色。定位和搜索控件常驻时，字节记录区至少保留四行；拖动上下分隔条时，增加的空间用于字节记录区。发送框高度固定为四行，更多文本在框内滚动。
- 接收速率按真实接收到的数据块统计，不会因为错误帧重复放大。
- 帧尾不匹配时，错误记录显示重同步过程中实际丢弃的字节，不重复列出相互重叠的候选帧；尚不足一帧的末尾字节会继续等待输入，暂停或断开时以“帧未完整”记录一次。
- 大于 5 万帧的 CSV 使用 Chrome 或 Edge 的文件保存接口分批写入，避免在内存中拼接完整 CSV。建议暂停采集后导出，以免导出过程中最早记录被覆盖。

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
  "plotWindowPoints": "1000",
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

## 10 项目结构与性能

```text
serial_plotter/
├── app.js
├── bridge.js
├── byteUtils.js
├── configStore.js
├── configValidation.js
├── configView.js
├── csvExport.js
├── dataParser.js
├── frameBuffer.js
├── index.html
├── monitorView.js
├── netEngine.js
├── package.json
├── plotMath.js
├── plotter.js
├── projectLimits.js
├── sendController.js
├── spectrum.js
├── readme.md
├── serialEngine.js
├── serial_config.json
├── styles.css
├── scripts/
└── tests/
```

采样与对应原始字节保存在相同长度的有界窗口中。实时绘图最多刷新 30 次/秒，监视台仅创建可见的日志行；暂停采集后可滚动查看窗口内每帧的原始 Hex。CSV 导出包含窗口内全部样本，并应用各通道已启用的放大与偏移；变换溢出的单元格留空。超过“最大采样点数”时淘汰最早的帧。

在 Node.js 24 环境运行 `npm run check` 检查 JavaScript 语法与空白格式，运行 `npm test` 执行解析、缓冲、通信、配置恢复和压力测试。压力测试会注入 30 万帧（23 通道）并核对保留的最新 5000 帧。实际浏览器绘制流畅度仍与设备和浏览器有关。

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

最后更新：2026-09-30

