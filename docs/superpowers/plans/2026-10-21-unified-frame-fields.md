# 整帧字段统一实现计划

> For agentic workers: use superpowers:executing-plans and complete the steps inline; preserve the existing uncommitted workspace.

**Goal:** 断帧、校验和命令分支都由同一整帧字段树描述，保留旧协议与稳定引用。

**Architecture:** v3 使用单个整帧根消息，字节数是字段的首要属性；0 表示必须显式配置长度来源或固定字段边界的变长内容。编译器从字段树推导流式边界和自动发送字段，旧 v1/v2 入口继续兼容；迁移为可编辑字段树时保留字段 ID、消息 ID 与路径别名。

**Tech Stack:** 原有经典 JavaScript 脚本、CommonJS 测试、零构建、现有共享后台线程池。

**Spec:** 本聊天中用户已批准的四项方案及后续确认：特征独立占字节；变长字段不包含特征；数据类型和用途可兼具。

## Global Constraints

- 不提交、不推送、不清理既有改动，保留 serial_config.json 的删除状态。
- 不重复请求已获准的方案；在当前连续开发工作区实现，避免遗漏大量尚未提交的依赖文件。
- 校验、长度、分支和边界依赖使用稳定字段 ID 或受限表达式，不执行用户 JavaScript。
- 固定内容、数值、原始字节、文本、位段、校验、互斥分支、子段、重复与 TLV 均可作为字段。
- 保留最大帧长、字段数、嵌套和重复上限；后台重建和实时解析使用同一编译逻辑。

## Review Focus

- 多个校验字段互相覆盖或循环依赖时拒绝应用；发送时先完成长度，再按依赖生成校验。
- 0 字节没有长度来源或合法边界时拒绝，缺失结束特征不吞掉后续字段或静默视为零长度。
- 旧消息/字段 ID、嵌套路径、发送指令与映射保留；重排与重命名不能静默换绑。
- cmd_id 分支长度不同、未知命令、跨块接收和无效帧的实时/重建结果保持一致。
- 新结构只配置一份规则；旧顶层 framing/checksums/dispatch 不能和新字段形成冲突的双重来源。

## Tasks

### 1. 核心字段编译与流式编解码

Files: protocolEngine.js, tests/protocolUnifiedFields.test.js, tests/historyWorkers.test.js.

- [x] 先写并观察失败测试：字段字节数、0 长度来源、固定字段边界、内联校验、字段引用范围和命令分支。
- [x] 实现 v3 单根字段树、编译推导、定长/长度/分隔流式边界、校验读取与自动生成；保留旧编译路径。
- [x] 验证任意分块、多个 CRC、负向输入、后台工厂和未知分支原始数据。

### 2. 旧配置投影迁移与引用

Files: protocolModel.js, dataEngine.js, protocolSendView.js, tests/protocolModel.test.js, tests/protocolSending.test.js, tests/dataEngine.test.js.

- [x] 先写失败测试：RoboMaster/旧自定义配置迁移后字节、稳定 ID、命令及嵌套映射不变。
- [x] 合并旧固定标记、长度、校验和消息分派为字段；保留兼容元数据供旧消息发送和映射使用。
- [x] 字段移动、重命名、复制、删除及引用检查覆盖新的长度/校验/边界引用。

### 3. 字段优先的整帧编辑器

Files: protocolEditorView.js, protocolEditor.css, tests/protocolEditorView.test.js.

- [x] 先写失败测试：删除整帧断帧入口、校验标签、添加消息流程；字段先显示字节数再显示作用。
- [x] 实现整帧树、0 字节提示与条件配置、校验字段范围、长度用途和互斥分支；协议库继续管理独立模板。
- [x] 验证旧草稿、撤销/重做、样例解析、错误位置、字段 ID、紧凑换行和属性面板状态。

### 4. 集成、说明与最终验证

Files: docs/protocol-editor.md, readme.md and affected integration tests.

- [x] 验证实际模板收发、映射、导出和重建；更新说明。
- [x] 运行 npm test、npm run check、git diff --check；读取完整结果。
- [x] 新上下文最终只读审查，修复实质问题并复验。浏览器访问若仍受既有拒绝限制则如实记录。

## Execution ledger

- Baseline: 上轮完整测试 1078/1078 通过；工作区包含既有尚未提交的数据引擎和协议编辑器开发，不另建遗漏这些改动的干净检出。
- Ruling: v3 仍沿用 messages[0] 作为整帧根，以保持成熟的消息 API；命令区别在 choice 字段内表达，界面不再添加独立消息。
- Ruling: 0 字节可明确选择所属有界段剩余长度（remaining），但没有可确定段末的配置必须报错。
- Ruling: 沿用普通数组按元素指定宽度的语义；重复和 TLV 的正字节数限定整个容器，界面与说明明确区分。
- Implemented: 核心、可视化整帧树、迁移、数据引擎字段映射、旧消息发送表单、真实后台线程与异步重建均使用 v3 字段逻辑。
- Review: 最终只读审查发现的定次重复、长度上下文、动态 count、布局选择、commandRange、隐式填充、条件校验循环、嵌套长度作用域、顺序 header 偏移已修复并通过回归；额外覆盖混合字节序与隐藏自动字段。
- Evidence: 最终完整 npm test 1106/1106 通过（101.47 秒，0 失败）；npm run check、已跟踪文件 git diff --check 及新增实现/测试/文档的逐文件空白检查通过。文档中的 v3 TLV 示例已用真实编译器解码校验。
- Limitation: 本轮沿用此前对浏览器文件页面访问的拒绝，不重试或绕过，因此没有新增浏览器视觉验收；编辑器交互通过 DOM 测试验证。
