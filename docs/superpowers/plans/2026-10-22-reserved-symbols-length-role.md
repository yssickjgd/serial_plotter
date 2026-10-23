# 统一系统符号及长度字段配置

> 保留当前工作区全部既有改动，不提交或推送。采用并行领域实现及集成复核。

## 用户已确认

- 用户表达式的系统变量和函数全部大写：CH 编号、DIFF／INT／FILTER、X／Y／N、FRAME_LENGTH／PAYLOAD_LENGTH／REMAINING／PARENT_REMAINING／PARENT／CURRENT／INDEX／SEQ／SEQUENCE／TRUE／FALSE、MIN／MAX／ABS。
- 命名及表达式大小写敏感；CH 编号只接受大写 CH。名称搜索保持可忽略大小写，文本搜索仍由现有开关控制。
- RoboMaster 的真实序号字段改为 rm_seq 等，不占用系统名字；保留字段稳定 ID、已有引用及自动发送序号功能。
- 界面提供统一保留名称说明；通道别名、协议变量及位字段命名检查冲突，显示标签和控件标题不作为表达式标识符。
- 长度在源字段配置：字节作用选长度，设置一个或多个控制目标、单位和修正量，自动建立已有 lengthSource 绑定；目标处显示关联并可回跳，不要求再次手动引用。

## 模块与接口

- reservedNames.js：共享大小写敏感名称清单、冲突说明及可折叠帮助，供经典脚本和 CommonJS 使用。
- 通道领域：channelOperations.js 及通道符号迁移；严格新语法，旧配置公式和差分系统自动迁移，不重绑定 CH 身份。
- 协议领域：protocolEngine.js、protocolSymbols.js、protocolSendView.js、robomasterProtocol.js；旧变量／函数和序号字段迁移，worker 同一规则，保持字节一致。
- 主集成：channelRegistry.js、protocolModel.js、protocolEditorView.js、engineChannelView.js、index.html、widgetConfig.js、dataEngine.js、说明文档与综合测试。
- 配置/协议新增独立符号版本标记，避免把新命名中的小写普通变量误当旧系统符号。

## 验收

- [x] 保留清单及命名检查先失败后通过，大小写区分但搜索行为不变。
- [x] 全大写通道函数／系统正确，旧配置迁移，普通小写别名不被错误改写。
- [x] 全大写协议表达式、序号迁移及 worker 一致，RoboMaster 独立参考字节通过。
- [x] 源长度字段配置、整帧／数据段多目标、单位修正、反向提示、重命名／排序／删除／撤销及拒绝不合法绑定。
- [x] 完整 npm test、npm run check、差异检查；浏览器此前无访问授权，不绕过。

内部 JSON 属性名、数据类型值和安全保护键保持配置契约，不视作用户表达式变量重命名。


## 集成复核补充

- 对旧名称中新保留的通道别名先按原身份绑定为 CH，再升级语法；保留显示名并提示命名冲突。
- 字段迁移同步更新映射、可见字段、常规／一键发送参数及保存的结构化样例；无效 JSON 草稿保持可编辑。
- 校验绑定不会因改为固定宽度被忽略；共享结构中的绑定按实例展开，两个实例可有不同长度。
- `PARENT` 等大写作用域与小写普通结构变量保持不同身份，字段重命名不会混淆引用。
- 旧固定整帧与自动长度同时存在的配置保留原行为；条件分支路径或共享结构的旧引用若有歧义，明确报错，不猜测改绑。

最终验证：`npm test` 1206 项全部通过（0 失败）；`npm run check` 通过；已跟踪改动及本轮新增文件的空白差异检查通过。浏览器此前无访问授权，本轮没有浏览器实测。
