# 位姿呈现控件开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可多实例使用的位姿控件，以 Euler 角、四元数或旋转矩阵显示机体朝向，支持叠加旋转、坐标轴配置和历史定位。

**Architecture:** 位姿视图直接读取 `CaptureService.numericSource.frames`，不新建解析器或复制历史。纯旋转计算、帧读取、Canvas 绘制、视图生命周期和属性面板分别实现，通过现有控件注册表接入工作区及公共工具。

**Tech Stack:** JavaScript 经典脚本、Canvas 2D、现有 Node 内置测试；不增加运行时依赖，保持直接打开 `index.html`。

**Spec:** 本文“一、功能与约定”记录本次对话已经确认的需求，以及实施采用的具体界面和算法方案。用户已授权在工作区交互更新提交后实施本计划。

## Global Constraints

- 数值帧规则、通道名称、通道运算、历史容量及暂停状态继续全局共用。
- 每个位姿实例独立保存输入表示、通道绑定、叠加旋转、坐标轴和相机设置。
- 保留 `serialplot_v3_config` 和配置 `version: 2`；已有配置和空工作区不自动新增位姿控件。
- 控件默认尺寸及新增尺寸继承、10/20/40 px 栅格、防重叠、多选移动、删除确认、标题聚焦往返全部复用工作区能力。
- 工作区缩放为 25%～500%，画布随工作区比例和屏幕密度重新绘制，不能拉伸旧位图。
- 每实例最多完成 30 次绘制/秒；持续采集时只绘制最新状态；不可见、静止或已销毁实例停止无用任务。
- 首批只显示朝向，不增加位置平移、轨迹、模型导入或姿态平滑。
- 此计划不要求提交或远端推送；实施与提交另按用户指令进行。

## Review Focus

1. 内旋/外旋、旋转方向与叠加顺序混淆：用不交换的两轴旋转校验，不能只测单位矩阵。
2. 两实例同时使用共享帧：配置与历史位置独立，数据不得被重复解析或追加。
3. 零四元数、退化矩阵和运算通道 NaN：不画错误姿态，也不把上一帧冒充当前帧。
4. 通道重排、删除、缩减数量：绑定保持指向原信号；失效绑定明确显示，不能静默改指其他通道。
5. 定位、清空和重建后的旧引用：定位必须在实际保留区间内，旧任务不能回写新会话或已销毁视图。

---

## 一、功能与约定

### 1. 栏目与操作

- 左侧“控件”新增“位姿”，支持拖入及添加按钮；可以添加多个实例。
- 标题默认“位姿 N”，沿用标题编辑、关闭确认及双击聚焦/再次双击恢复。
- 右侧提供三个并列栏目：**帧解析、显示方式、通道配置**。
- 帧解析直接显示共享数值帧设置，包括重建历史开关、数据类型、端序、通道数、帧首、帧尾及校验。明确提示“影响所有数值控件”。
- 显示方式按“输入姿态”“叠加旋转”“坐标轴与机体”“观察视角”分组，只显示当前适用参数，并保留隐藏参数的选择。
- 通道配置分别列出姿态及启用的叠加旋转所需分量，选择框显示 `CH01＋名称`。只允许原始数据和标量运算通道，排除常量数组、差分方程系统。
- 未绑定分量显示“请选择通道”，不猜测数据含义。允许同一通道用于多个分量。

### 2. 输入姿态

内部统一使用右手主动旋转、列向量和 3×3 矩阵：

```text
v_odom = R × v_body
```

默认输入方向为 body→odom；反向输入选项将解码矩阵转置后再使用。方向设置作用于输入姿态，不反转叠加旋转。表示切换不更改共享帧规则。

| 表示 | 可配置内容 | 默认值 |
|---|---|---|
| Euler 角 | YPR/YRP/PYR/PRY/RYP/RPY；内旋/外旋；角度/弧度 | 内旋 YPR，弧度 |
| 四元数 | wxyz/xyzw；自动归一化 | wxyz，开启归一化 |
| 旋转矩阵 | 9 个按行标注的分量；自动单位正交化 | 开启正交化 |

Euler 的 Y/P/R 分别表示绕 Z/Y/X 轴的 yaw/pitch/roll；输入绑定始终按 yaw、pitch、roll 标注，不随顺序选项换义。内旋按当前机体轴，外旋按固定参考轴；两个选项不在一次组合中混用。[内旋与外旋的定义](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.transform.Rotation.from_euler.html)

四元数采用 Hamilton 约定，`q` 和 `-q` 表示同一朝向。单位四元数才代表纯旋转；归一化按缩放后范数计算，避免大有限数溢出。[四元数次序及主动旋转约定](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.transform.Rotation.from_quat.html)

矩阵归一化只修正非正交误差；零矩阵、奇异矩阵和反射矩阵不能作为普通旋转接受。有效结果须满足 `RᵀR≈I`、`det(R)≈+1`。[旋转矩阵的正交及右手要求](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.transform.Rotation.from_matrix.html)

### 3. 叠加旋转

- 独立启用，默认关闭；支持 Euler、四元数、旋转矩阵。
- 数值来源可选“固定参数”或“通道来源”，两种设置各自保留。固定参数默认单位旋转。
- Euler 叠加也提供六种顺序、内旋/外旋及角度/弧度；四元数与矩阵提供相同的归一化选项。
- 界面同时注明运算顺序与矩阵乘法，避免仅用“前/后”产生歧义：

| 选择 | 最终矩阵 | 含义 |
|---|---|---|
| 先叠加、后输入 | `R × A` | 机体系中的附加旋转 |
| 先输入、后叠加（默认） | `A × R` | odom 系中的附加旋转 |

固定叠加不参与搜索通道列表；通道叠加的各分量从与输入姿态相同的数值帧读取，不拼接不同时刻的数据。

### 4. 坐标轴、手系与立方体

- 固定 odom 轴、随姿态旋转的 body 轴和机体立方体共用原点。
- 默认方向：前 X、左 Y、上 Z；默认右手系。
- odom 轴 RGB 强度为 128：`#800000 / #008000 / #000080`；body 轴 RGB 强度为 255：`#ff0000 / #00ff00 / #0000ff`。按已确认的数值强度实现。
- 立方体：前红 `#ff0000`、后橙 `#ff8c00`、上蓝 `#0000ff`、下绿 `#00ff00`、左白 `#ffffff`、右黄 `#ffff00`。
- odom/body 分别提供显示开关、轴朝向和左右手选项；立方体提供显示开关。轴带 X/Y/Z 与 odom/body 标签，并使用不同长度区分重合轴。
- 朝向配置使用“X 正向、Y 正向、手系”；Y 不可与 X 共线，Z 按手系自动计算并显示。避免出现“前 X 左 Y 上 Z＋左手”这类矛盾组合。
- **显示方案：**坐标轴配置定义显示基底，不偷偷改写 Euler 正角、四元数乘法或输入方向。设 `B_odom/B_body` 为所选轴朝向的基底，则 odom 轴画 `B_odom`，body 轴画 `R_final × B_body`；立方体使用 `R_final`，始终与 body 轴一起转动。左手显示基底允许行列式为 -1，但不能混入姿态矩阵的 SO(3) 校验。
- 默认观察方向从前、左、上看向原点，能同时看见三个面；正交投影避免透视导致的轴长误判。
- 鼠标在内容区拖动旋转观察视角，普通滚轮改变观察距离；Ctrl＋滚轮仍缩放工作区。右键内容区恢复默认观察视角及最新跟随，右键空白工作区保持工作区行为。

### 5. 状态、历史与公共工具

- 实时跟随最新数值帧；全局暂停后保留当前姿态，时间定位及搜索可跳到对应历史帧。
- 状态栏显示当前目标帧时间和有效性；无数据、未绑定、重建中、无效输入分别给出明确提示。
- 无效输入不生成新姿态。若保留上一次已显示的有效姿态，则降低显示亮度，同时标明该姿态时间与当前无效目标时间，不能显示成当前有效数据。
- 来源清空或变更时清除旧姿态；历史目标被淘汰时恢复最新跟随并提示。
- 位姿作为当前激活控件时，搜索类型为通道数值，搜索输入及通道叠加所绑定的标量通道；保留既定首次方向、后续方向及循环搜索。
- 就近参考：跟随时取最新数值帧；历史查看时取当前选中帧。同步跳转使用原始字节区间，不把缺口或范围外目标压到边界。
- 搜索及定位命中在位姿中显示对应帧状态，在波形/字节流中保持原有竖线与高亮。
- 导出仍在左侧，读取共享数值缓冲区；位姿不制造一份独立采样缓存，不改变现有四种导出格式。
- 修改实例显示、映射或叠加只重新读取目标帧；修改共享数值规则仍遵循共用“重建历史数据”开关。

## 二、文件与接口

| 文件 | 职责 |
|---|---|
| 新增 `poseMath.js` | 纯矩阵运算、表示转换、正交化、叠加、显示基底 |
| 新增 `poseConfig.js` | 默认值、嵌套设置校验、绑定重排 |
| 新增 `poseData.js` | 从同一数值帧读取分量，返回姿态和原始位置元数据 |
| 新增 `poseRenderer.js` | 场景几何、相机投影、遮挡及 Canvas 绘制 |
| 新增 `poseView.js` | 历史位置、渲染调度、相机交互、销毁 |
| 新增 `poseConfigView.js` | 右侧显示方式与通道绑定 UI |
| 修改 `widgetController.js` | 注册/创建/配置/重排/重建通知；第三种视图的明确分支 |
| 修改 `widgetConfig.js` | 接受 pose 类型及实例设置，保持 version 2 |
| 修改 `workspaceTools.js` | 位姿数值搜索、参考帧、同步跳转和搜索命中 |
| 修改 `app.js` | 画布缩放与统计分支；避免将位姿当作字节流 |
| 修改 `index.html`、`styles.css` | 控件库、模板、共享解析宿主、属性面板及样式 |
| 修改 `tests/helpers/widgetAppHarness.js` | 新模板/属性与画布桩，复用现有应用测试环境 |
| 新增对应 `tests/pose*.test.js` | 计算、校验、读取、绘制与生命周期测试 |
| 修改既有控件/配置/工具测试及说明 | 验证第三种控件和旧行为兼容 |

关键接口固定为：

```js
// poseMath.js：均为纯函数；矩阵为按行排列的 9 个有限数。
PoseMath.fromEuler(values, { order, rotation, unit }); // values: [yaw,pitch,roll]
PoseMath.fromQuaternion(values, { order, normalize });
PoseMath.fromMatrix(values, { orthonormalize });
PoseMath.multiply(a, b); PoseMath.transpose(matrix); PoseMath.apply(matrix, vector);
PoseMath.compose(input, overlay, order); // order: overlay-first | input-first
PoseMath.displayBasis({ x, y, hand });
// 转换结果：{ valid: true, matrix } 或 { valid: false, reason }。

// poseConfig.js
PoseConfig.defaults();
PoseConfig.normalize(settings, { channelCount, isSignal } = {}); // 返回完整副本；错误抛出中文说明。
PoseConfig.remapBindings(settings, numberMap); // Map<旧 CH 编号, 新 CH 编号>；删除项置 null。

// poseData.js
PoseData.read(frames, index, settings); // 同一帧读取全部分量。
// {valid,matrix?,reason?,order,timestamp,startByte,endByte,index}

// poseRenderer.js
PoseRenderer.buildScene(settings, pose); // 返回世界坐标中的面、线段和标签。
PoseRenderer.projectScene(scene, camera, width, height);
PoseRenderer.draw(context, scene, camera, width, height);

// poseView.js
new PoseView(canvas, frames, { settings, statusElement, requestAnimationFrame, cancelAnimationFrame, now });
view.setFrames(frames); view.setSettings(settings); view.requestRender();
view.setPaused(paused); view.setVisible(visible); view.resize(); view.dispose();
view.jumpToFrame(index); view.jumpToByteOffset(offset); // bool，范围外返回 false。
view.getReferenceByteOffset(); // number | null
view.setSearchResults(matches, current); // 更新当前目标的命中状态。
view.setNavigationMarkers(markers); // timeOrder 等定位状态。
view.completedDraws; view.frames; // 供公共工具及实际绘制统计使用。
```

## 三、分阶段实施

### 阶段 1：旋转计算与精确约定

**文件：**新增 `poseMath.js`、`tests/poseMath.test.js`。

- [ ] 写失败测试：单位姿态、三个轴的 ±90°、六顺序、内外旋反序等价，以及两种叠加顺序不等价。

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseMath } = require('../poseMath');
const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9));
test('yaw turns forward toward left, and reversed input transposes the rotation', () => {
    const { matrix } = PoseMath.fromEuler([Math.PI / 2, 0, 0], { order: 'YPR', rotation: 'intrinsic', unit: 'radians' });
    close(PoseMath.apply(matrix, [1, 0, 0]), [0, 1, 0]);
    close(PoseMath.apply(PoseMath.transpose(matrix), [1, 0, 0]), [0, -1, 0]);
});
test('intrinsic YPR equals extrinsic RPY with the same named angles', () => {
    const angles = [0.7, -0.4, 0.2];
    close(PoseMath.fromEuler(angles, { order: 'YPR', rotation: 'intrinsic', unit: 'radians' }).matrix,
        PoseMath.fromEuler(angles, { order: 'RPY', rotation: 'extrinsic', unit: 'radians' }).matrix);
});
```

- [ ] 运行 `node --test tests/poseMath.test.js`，确认因模块缺失失败。
- [ ] 实现标准右手 `Rx/Ry/Rz`；内旋按顺序右乘，外旋按顺序左乘。四元数先按次序恢复 w/x/y/z，再使用标准主动旋转公式。

```js
const atoms = { Y: rotationZ(yaw), P: rotationY(pitch), R: rotationX(roll) };
let matrix = identity();
for (const key of order) matrix = rotation === 'intrinsic'
    ? multiply(matrix, atoms[key]) : multiply(atoms[key], matrix);
// rotationX/Y/Z、identity、multiply 为 poseMath.js 内部纯函数。
```

- [ ] 加归一化/无效输入测试：四元数 `q/-q`、wxyz/xyzw 等价、范数极大/极小但有限、全零、NaN；矩阵含缩放/剪切、全零、行重复、反射、非有限。
- [ ] 四元数以最大绝对值缩放后计算单位化；关闭单位化时范数偏差超过 `1e-6` 则报错，不偷偷修正。
- [ ] 矩阵先按最大绝对值缩放检查可逆性和正行列式；自动正交化使用极分解迭代 `X_next=(X+X⁻ᵀ)/2`，最多 32 次，最终正交残差和行列式误差不超过 `1e-8`。归一化后的行列式不大于 `1e-12`、不收敛或反射均拒绝。关闭正交化时原矩阵误差不得超过 `1e-6`。
- [ ] 测试 `R×A` 与 `A×R` 对前向向量的不同结果；测试显示基底的轴互斥、左右手行列式及默认 FLU。
- [ ] 重跑数学测试，全部通过后进入下一阶段。

### 阶段 2：配置、默认值与绑定生命周期

**文件：**新增 `poseConfig.js`、`tests/poseConfig.test.js`；修改 `widgetConfig.js`、`tests/widgetConfig.test.js`。

完整设置使用以下结构，所有隐藏表示的参数仍保留：

```js
{
    representation: 'euler', inputDirection: 'body-to-odom',
    euler: { order: 'YPR', rotation: 'intrinsic', unit: 'radians' },
    quaternion: { order: 'wxyz', normalize: true }, matrix: { orthonormalize: true },
    bindings: { euler: [null, null, null], quaternion: [null, null, null, null], matrix: Array(9).fill(null) },
    overlay: {
        enabled: false, representation: 'euler', source: 'fixed', order: 'input-first',
        euler: { order: 'YPR', rotation: 'intrinsic', unit: 'radians' },
        quaternion: { order: 'wxyz', normalize: true }, matrix: { orthonormalize: true },
        fixed: { euler: [0, 0, 0], quaternion: [1, 0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
        bindings: { euler: [null, null, null], quaternion: [null, null, null, null], matrix: Array(9).fill(null) }
    },
    axes: {
        odom: { x: 'forward', y: 'left', hand: 'right', visible: true },
        body: { x: 'forward', y: 'left', hand: 'right', visible: true }
    },
    cubeVisible: true, camera: { azimuth: Math.PI / 4, elevation: Math.PI / 6, scale: 1 }
}
```

- [ ] 写默认值、嵌套对象深复制、隐藏值保留和 pose 配置往返的失败测试。
- [ ] 运行 `node --test tests/poseConfig.test.js tests/widgetConfig.test.js`，确认新增断言失败。
- [ ] 实现严格枚举、布尔、有限数与固定数组长度校验；绑定采用从 0 开始的通道索引或 null。轴向仅可为 front/back/left/right/up/down 对应的内部规范值 `forward/backward/left/right/up/down`，X/Y 不共线。相机仰角限制在 ±89°，倍率在 0.25～4。
- [ ] 在 `normalizeWidgetSettings` 和 `validateWorkspaceConfig` 明确接受 `pose`，保持老格式迁移和整体导入先校验后替换。校验导入绑定时，用候选全局规则建立 `ChannelOperations`，传入其 `channelCount`；`isSignal(index)` 使用 `index < 原始通道数 || engine.entries.get(index + 1)?.definition.type === 'formula'`，不借用当前会话的旧通道数量。
- [ ] 测试非法类型、非有限固定参数、越界绑定、非法轴组合导入不会替换现有应用。对运行时已删除通道，保留错误提示并清空绑定，不把导入时的非法设置悄悄改成有效配置。
- [ ] 测试通道互换、前方删除及原始通道数改变：按 `numberMap` 重映射输入和叠加的全部隐藏绑定；被删信号置 null。
- [ ] 相关测试全部通过。

### 阶段 3：共享帧读取与无效状态

**文件：**新增 `poseData.js`、`tests/poseData.test.js`。

- [ ] 写相同帧读取、反向输入、固定/通道叠加、无数据/缺绑定/NaN 的失败测试。

```js
test('pose reads every component from one retained frame without appending data', () => {
    const { FrameBuffer } = require('../frameBuffer');
    const { PoseConfig } = require('../poseConfig');
    const { PoseData } = require('../poseData');
    const frames = new FrameBuffer(3, 10);
    frames.append([0, 0, 0], Uint8Array.of(1), 0, 1, 1000, { byteOffset: 10 });
    frames.append([Math.PI / 2, 0, 0], Uint8Array.of(2), 1, 2, 1001, { byteOffset: 11 });
    const settings = PoseConfig.defaults(); settings.bindings.euler = [0, 1, 2];
    const pose = PoseData.read(frames, 1, settings);
    assert.equal(pose.valid, true); assert.equal(pose.startByte, 11);
    assert.equal(pose.timestamp, 1001); assert.equal(frames.length, 2);
});
```

- [ ] 运行 `node --test tests/poseData.test.js`，确认新增测试失败。
- [ ] 只用 `getValue`、`isSignal`、`timestampAt`、`orderAt`、`rawByteOffsetAt` 读取，组合方向及叠加矩阵；不改 frames。帧结束位置使用可选的 `rawEndByteAt`；未提供时使用 `rawByteOffsetAt(index) + rawBytesAt(index).length`，与现有公共工具相同。
- [ ] 为普通 FrameBuffer 无 `isSignal` 的测试替身提供“索引小于 channelCount”判断，生产 ComputedFrames 始终使用 `isSignal`。
- [ ] 验证原始与运算通道均可绑定，数组/系统不可绑定；叠加中任一无效分量使整帧姿态无效。给错误标明分量名称和通道。
- [ ] 验证同源两个设置得到不同姿态而帧数不变、覆盖后旧索引不读取错误帧、清空返回无数据、重建前后只读取当前 frames。
- [ ] 相关测试全部通过。

### 阶段 4：场景绘制、交互与调度

**文件：**新增 `poseRenderer.js`、`poseView.js`、`tests/poseRenderer.test.js`、`tests/poseView.test.js`。

- [ ] 写场景几何测试：单位姿态下六面颜色与法向对应、odom 不转/body 与立方体同转、左手显示不会污染姿态矩阵。
- [ ] 写投影测试：默认视角能看见前/左/上，面朝向剔除及深度排序正确；投影宽高有限，输入非法姿态不产生 NaN 绘图坐标。
- [ ] 运行两个新增测试文件，确认缺少模块时失败。
- [ ] 先用世界顶点和可见面构建场景，再正交投影；远到近绘制面和线段，轴被机体遮挡的部分采用虚线，标签带浅色轮廓以免与面色混淆。轴长分别为 1.6（odom）和 1.2（body），立方体边长为 1。
- [ ] 写注入时钟和 rAF 的视图测试：5000 次数据通知只排一个待绘制任务，`1000/30` ms 内不重复画；暂停且未变化时不画，改设置/改视角/改尺寸时仍会请求一次。
- [ ] 实现状态键 `{frames对象, frames.version, order, settingsRevision, cameraRevision, width, height, density}`；通知只标 dirty，rAF 读取最新帧，完成 draw 后递增 `completedDraws`。不扫描全部保留历史、不按每个接收帧复制矩阵。
- [ ] Canvas 物理尺寸按内容区逻辑宽高×工作区比例×devicePixelRatio 设置；上下文再按对应比例绘制。倍率变化触发 resize，暂停时也重新栅格化。
- [ ] 普通内容拖动只改相机；标题及边缘仍交给工作区；Ctrl＋滚轮不由相机拦截。内容右键仅恢复相机和最新跟随。
- [ ] 按 `order` 保存历史目标而非移动的数组索引；帧被淘汰、切换来源、清空时按功能约定更新状态。
- [ ] 验证无效姿态显示时间不冒充当前帧、关闭再打开可见性只绘制当前状态、销毁后事件和 rAF 不再回调，重复 dispose 安全。
- [ ] 相关测试全部通过。

### 阶段 5：工作区实例与属性面板

**文件：**新增 `poseConfigView.js`；修改 `index.html`、`styles.css`、`widgetController.js`、`app.js`、`tests/helpers/widgetAppHarness.js`、`tests/widgetController.test.js`、新增 `tests/poseConfigView.test.js`。

- [ ] 写两个 pose 实例创建、独立设置、激活后正确栏目、共享帧规则修改同步全部数值实例的失败测试。
- [ ] 运行 `node --test tests/poseConfigView.test.js tests/widgetController.test.js`，确认新增断言失败。
- [ ] 控件模板使用 `data-role="pose-header/pose-canvas/pose-status/stat-plot-fps"`，复制模板后由既有逻辑生成实例 ID；新增库按钮 `data-add-widget="pose"`。
- [ ] 注册 pose 并明确数值数据源、标题角色及视图创建路径，移除会把第三类型落入字节流的二选一分支；原波形/字节流测试保持通过。

```js
// 创建 pose 时使用既有源，生命周期结束只释放引用。
const source = this.service.acquireSource({ captureMode: 'number' });
widget.view = new SerialPlotter.PoseView(refs['pose-canvas'], source.frames, {
    settings: widget.settings, statusElement: refs['pose-status']
});
// 捕捉变化由既有 syncData(source) 通知，不新增接收入口。
widget.view.setFrames(widget.source.frames);
widget.view.requestRender();
```

- [ ] 共享解析 DOM `shared-numeric-settings` 移至 pose 的解析宿主，保持一份有效 DOM 和相同字段 ID；切换实例时恢复到对应宿主。
- [ ] 实现表示/来源/启用条件显隐；固定矩阵使用 3×3 小输入框；通道矩阵按 m11～m33 排列。非法输入在所属组下方报错，合法后自动生效。
- [ ] `applySettings/syncData/resize/syncGlobals/_whenReady` 增加 pose 分支；`app.js` 缩放重绘包括 pose，统计不能访问 pose 不存在的字节流节点。完成绘制帧率按实际 `completedDraws` 的差计算。
- [ ] 通道重排与删除钩子调用 `PoseConfig.remapBindings`；标题重命名、配置序列化与应用导入保存完整实例设置及相机，不保存会话内历史 order。
- [ ] 验证删除确认取消/确认、双击聚焦恢复、Ctrl＋A、同类型尺寸继承、拖入和恢复布局均支持 pose。
- [ ] 相关测试全部通过。

### 阶段 6：定位搜索与数据范围

**文件：**修改 `workspaceTools.js`、`tests/workspaceTools.test.js`；补充 `tests/poseView.test.js`、`tests/widgetController.test.js`。

- [ ] 写 pose 激活后显示数值搜索、同步跳转与独立就近参考的失败测试，不把 pose 的缺省 captureMode 当作 Hex。
- [ ] 运行上述测试文件，确认新增行为失败。
- [ ] 为 pose 返回 number 搜索类型；搜索通道候选取当前姿态绑定与启用的通道叠加绑定去重，读取共享原值/运算值。
- [ ] `jumpToByteOffset` 只在 `[startByte,endByte)` 内找到完整保留帧时成功；跳到有效帧即请求绘制并退出跟随。无效姿态仍能定位该数值帧，但标注无效；范围外目标返回 false。
- [ ] 时间定位和搜索成功后同步其他控件；用当前帧 order 标注 pose 命中，波形竖线及字节高亮保持既有样式。
- [ ] 验证首次反向/后续正常/首尾循环规则、单结果/无结果、异步使用点击时参考位置、激活变化取消旧搜索、删除参考要求重新选择。
- [ ] 验证两种断帧长度不同、解析错误产生的缺口、头尾目标、覆盖淘汰、清空、重建及原始历史保留不足，均不会生成虚假的边界命中。
- [ ] 相关测试全部通过。

### 阶段 7：浏览器、性能与说明

**文件：**更新 `readme.md`、`architecture.md`；测试结果留在现有忽略的 `tmp/`，不提交测试数据。

- [ ] 全量运行 `npm test`、`npm run check`、`git diff --check`，全部通过。
- [ ] Chrome/Edge 以 `file://` 检查宽/窄窗口，添加三个不同表示实例；用零姿态、Z 正转 90°、混合旋转核对面色和轴方向，并检查叠加次序。
- [ ] 检查帧解析共享、隐藏设置保留、左手显示基底、不同实例映射、相机转动、内容/标题/工作区右键分工、删除确认、双击聚焦往返和配置往返。
- [ ] 在 81%、155%、500% 工作区倍率和高 DPI 下核对画布清晰度、鼠标投影坐标和控件边界；定位头尾时不显示负坐标区间。
- [ ] 同一接收入口持续注入 23 通道、5000 帧/秒、60 秒，保留现有基线，并加入两个 pose、两个波形、两个字节流实例。核对解析帧数 300000、保留窗口内原始值/字节不变；记录每实例实际绘制频率、交互 P95 和内存变化，不把渲染丢中间状态误报为采集丢帧。
- [ ] 检查离开可见区不绘制，重新进入显示最新姿态；反复增删 100 次无残留 rAF、监听或观察器，清空/销毁后的旧任务不能回写。
- [ ] 更新说明，包含数据方向、内外旋、四元数约定、叠加乘法、显示基底和无效状态的具体示例。

## 四、验收结果

实施完成后应交付：可正常运行的第三种控件、共享解析及多实例支持、明确的旋转约定与错误状态、定位搜索兼容、配置迁移与生命周期测试，以及真实浏览器性能记录。第一版不将平移轨迹、滤波或复杂模型加入此轮开发。

### 实施验证记录（2026-10-10）

- `npm test`：709 项通过；`npm run check` 与 `git diff --check` 通过。
- Chrome 153 / Windows，直接打开 `index.html`：Euler、四元数、矩阵对同一 Z 轴正转 90° 得到一致姿态；检查内容拖动、滚轮、右键、标题聚焦往返、删除确认及配置往返，无浏览器异常。
- 900 px 窄窗口属性栏没有横向溢出；DPR 2 下验证 81%、155%、500% 工作区倍率，画布随实际显示尺寸重新栅格化。
- 连续创建/删除 100 个位姿控件：窗口 resize 监听数量不变，200 个实例观察器释放，共享源引用数和控件数回到原值，删除实例没有后续绘制。移出可见区不绘制，返回后显示最新姿态。
- 单波形基线：23 通道全可见、5000 帧/秒、60 秒，解析 300000 帧；最新 5000 帧的全部数值和原始字节逐项一致，实际绘制约 27.4 FPS。
- 两波形＋两字节流＋两位姿：相同输入 300000 帧，窗口数据逐项一致；时域波形及两位姿约 26.8 FPS，频域约 9.7 FPS；从相机操作到完成绘制的交互延迟 P95 为 34.9 ms。上述为当前浏览器模拟入口结果，未包含串口设备传输延迟。
- CDP 内存记录：单波形测试起点 JS 堆约 3.28 MB，末尾约 5.89 MB，末尾 backing storage 约 50.12 MB；多控件测试末尾 JS 堆约 20.09 MB，backing storage 约 51.47 MB。均为采样时值，未强制 GC，不当作精确持有量或泄漏结论。
- 最终代码复查发现两处问题并补充先失败后通过的测试：异步减少通道数时按新规则解除已删除标量的绑定；连续遮挡轴段合并路径，使虚线相位不逐段重置。

实施取舍：Windows 沙箱禁止测试子进程，采用项目既有的 `--test-isolation=none`；在忽略的 `tmp` 下隔离开发并回合原工作目录；清空/数据源代次变化时撤销上一会话的有效姿态，避免无效新帧沿用旧姿态。
