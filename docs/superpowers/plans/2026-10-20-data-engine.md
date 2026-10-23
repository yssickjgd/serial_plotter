# 数据引擎集中配置与通用自定义帧实施记录

依据用户在当前会话批准的完整计划实施。当前目录直接交付，不提交或推送；保留用户删除 serial_config.json 的状态。

## 目标

- 全局单引擎 Raw_Data / Data_Array / Self_Defined_Frame，控件只读呈现。
- 左侧上方保留通讯/控件/导出，下方数据引擎含帧解析、通道管理、同步采样；分隔比例持久化。
- 总通道 65535，显示 CH00001，兼容 CH1/CH01；稳定身份、中文标识符、名称引用及补全、虚拟列表。
- 完整二进制协议编解码与RoboMaster2026第1章模板，显式应用草稿，结构化发送和字段定位。
- 消息独立序列和1000Hz默认同步采样，因果保持/可配置过期，空闲推进，暂停断开不补点。
- IndexedDB完整配置异步保存，兼容旧配置与JSON，失败不覆盖旧配置。

## 模块与契约

1. protocolEngine.js / robomasterProtocol.js：Protocol.compile(schema), decode(bytes,compiled), encode(compiled,messageId,fields,{sequence,layout})；Protocol.StreamParser拥有DataParser同形接收回调，回调首参数为结构化record。flatFields为含fieldId/path/value/numeric/byteOffset/endByte/bitOffset?/bitLength?的数组。
2. channelRegistry.js / channelAutocomplete.js及通道运算基础：稳定ID、名称解析和五位编号、65535限额，保留旧公式兼容。
3. workspaceStorage.js：异步load/save/flush，IndexedDB优先，旧localStorage迁移；小配置镜像兼容。
4. dataEngine.js / engineFrames.js：引擎服务与投影/同步输出，按原始字节定位，采集预算及历史重建。
5. dataEngineView.js / protocolEditorView.js：左侧引擎、协议预览与通道管理；右侧只保留显示。

## 进度

- [x] 通道基础及大规模存储
- [x] 左侧引擎与独立呈现
- [x] IndexedDB与配置迁移
- [x] 自定义协议及完整模板
- [x] 同步采样/结构化发送/搜索导出
- [x] 采集性能与使用文档
- [x] 全量回归、语法及差异检查
- [ ] Chrome／Edge视觉、绘图帧率及真实交互验收（本地页面访问未获工具许可）

## 执行记录

- 三个独立实现任务：协议核心、通道核心、异步存储。主代理负责采集/缓存、界面、工具及集成。
- 初始基线：上轮818项通过；当前用户未提交改动只有serial_config.json删除。
- 配置升级为v3，异步事务成功后完成迁移；导入前校验模式、协议、通道目录和内存需求。无效草稿可保存，但不能作为运行配置应用。
- 协议模块使用受限表达式；支持长度单位、保留字段、精确64位整数和复用结构。RoboMaster模板覆盖31个根命令及第一章子命令；用22组手工载荷和PDF查表CRC参考值独立校验，未以编解码自身往返代替参考样例。
- 同步表使用事件及保持区间，采样率、有效期及公式状态按输出隔离。公式来源跟随实际输入、历史索引和旧公式生效区间；没有原始输入的常量结果不伪造跳转。
- 结构化消息CSV异步发现字段列；变长数组使用可还原JSON。独立消息数值直接导出投影值；bin/hex/txt只提供真正保存原始字节的来源，避免重复导出同步保持值。
- 60秒Node双引擎实测：数组及混合协议各23通道、5000帧/秒，均300000帧、0丢帧，字节哈希及最新5000帧严格一致；事件循环P95 7.075ms、最大20.718ms。此结果不含浏览器绘图与鼠标延迟。
- 本地浏览器页面访问被工具拒绝，未尝试绕过；Chrome／Edge实际视觉及绘图指标仍需在目标设备验收。
- 最终验证：`npm test` 989项通过、0失败（含本机TCP/UDP/WebSocket桥接测试）；`npm run check`及`git diff --check`通过。未提交、未推送，serial_config.json仍为用户删除状态。
