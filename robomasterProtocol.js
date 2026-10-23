/** RoboMaster 2026 university series serial protocol, V2.0.0 (2026-06-26).
 * Official default: data_length includes only the data payload, not CRC16.
 * Whole-frame length = data_length + 9. Saved custom protocols are not rewritten.
 * Message layouts and CRC algorithms continue to follow the source below.
 * Source: authoritative PDF chapter 1, printed pages 4–43, and CRC appendix
 * pages 75–78. This preset intentionally covers serial messages only.
 *
 * Public API: {schema,preset,compiled,source,commands,compile,createParser,
 * createSchema,legacySchema}. schema/preset are unified editable JSON with
 * independent rules; legacySchema is the prior representation for explicit
 * compatibility use. createSchema makes a clean
 * copy. IDs rm2026.<4-digit lowercase command>[.<subcommand>] remain stable.
 * The command catalog includes every chapter-one root command, all interaction
 * commands, and the 0x0200–0x02ff robot communication range.
 *
 * Conflicts are retained in each message's conflicts array and surfaced on every
 * decode. The detailed field tables/packed definitions take precedence. Sending
 * an ambiguous layout requires {layout:'detail'}. No length is silently inferred
 * from the inconsistent summary table. Extra received bytes are retained by the
 * generic engine. Protocol units and transmission constraints are metadata only;
 * the codec does not send automatically or enforce game rules/rate limits.
 */
(function (root) {
    'use strict';
    const Protocol = typeof module !== 'undefined' && module.exports
        ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
    const ProtocolModel = typeof module !== 'undefined' && module.exports
        ? require('./protocolModel').ProtocolModel : root.SerialPlotter.ProtocolModel;
    const source = { title: 'RoboMaster 2026 机甲大师高校系列赛通信协议',
        version: 'V2.0.0（20260626）', chapter: 1, pages: '4–43', crcPages: '75–78',
        fileName: 'RoboMaster 2026 机甲大师高校系列赛通信协议 V2.0.0（20260626）.pdf' };
    const field = (name, type, extra = {}) => ({ name, type, ...extra });
    const u8 = (name, extra) => field(name, 'uint8', extra);
    const u16 = (name, extra) => field(name, 'uint16', extra);
    const u32 = (name, extra) => field(name, 'uint32', extra);
    const f32 = (name, extra) => field(name, 'float32', extra);
    const bit = (name, offset, length = 1, extra = {}) => ({ name, offset, length,
        ...(length === 1 ? { type: 'bool' } : {}), ...extra });
    const raw = (name, length, extra) => field(name, 'bytes', { ...(length === undefined ? {} : { length }), ...extra });
    const flags = (name, type, bits, extra) => field(name, type, { bits, ...extra });
    const message = (command, name, length, fields, extra = {}) => ({
        id: `rm2026.${command.toString(16).padStart(4, '0')}`, command, name,
        ...(length === undefined ? {} : { length }), fields, ...extra });
    const child = (command, name, length, fields, extra) => ({
        ...message(command, name, length, fields, extra),
        id: `rm2026.0301.${command.toString(16).padStart(4, '0')}` });
    const conflict = (...conflicts) => ({ requireLayout: true, conflicts,
        layouts: { detail: { name: '详细字段定义（2026）' } } });
    const targetEnum = { 0: '未命中/未选择', 1: '前哨站', 2: '基地固定目标', 3: '基地随机固定目标',
        4: '基地随机移动目标', 5: '基地末端移动目标' };
    const occupied = { 0: '未占领', 1: '己方占领', 2: '对方占领' };
    const sharedOccupied = { ...occupied, 3: '双方占领' };
    const stances = { 1: '进攻', 2: '防御', 3: '移动', 4: '强化进攻', 5: '强化防御', 6: '强化移动' };
    const robotKinds = ['hero','engineer','infantry_3','infantry_4','aerial','sentry'];
    const positions = (team, preserveIds = false) => robotKinds.flatMap((kind, index) => ['x','y'].map(axis =>
        u16(`${team}_${kind}_position_${axis}`, { unit: 'cm', ...(preserveIds && kind !== 'aerial'
            ? { id: `rm2026.0305.${['hero','engineer','standard_3','standard_4','aerial','sentry'][index]}_position_${axis}` } : {}) })));
    const graphic = [raw('figure_name', 3, { description: '图形名，删除/修改时作为索引' }),
        flags('config1', 'uint32', [
            bit('operate_type', 0, 3, { enum: { 0: '空操作', 1: '增加', 2: '修改', 3: '删除' } }),
            bit('figure_type', 3, 3, { enum: { 0: '直线', 1: '矩形', 2: '正圆', 3: '椭圆', 4: '圆弧', 5: '浮点数', 6: '整型数', 7: '字符' } }),
            bit('layer', 6, 4, { description: '图层数 0–9' }),
            bit('color', 10, 4, { enum: { 0: '己方颜色', 1: '黄色', 2: '绿色', 3: '橙色', 4: '紫红色', 5: '粉色', 6: '青色', 7: '黑色', 8: '白色' } }),
            bit('details_a', 14, 9, { description: '圆弧起始角度/数值或字符字体大小' }),
            bit('details_b', 23, 9, { description: '圆弧终止角度/字符长度' })]),
        flags('config2', 'uint32', [bit('width', 0, 10), bit('start_x', 10, 11), bit('start_y', 21, 11)],
            { description: '屏幕坐标原点左下角，1920×1080，字体大小/线宽建议10:1' }),
        flags('config3', 'uint32', [bit('details_c', 0, 10, { description: '圆半径；数值低10位' }),
            bit('details_d', 10, 11, { description: '终点X/半轴X；数值中11位' }),
            bit('details_e', 21, 11, { description: '终点Y/半轴Y；数值高11位' })],
        { description: '浮点图形：此32位有符号整数/1000；整数图形：此32位有符号整数；圆弧0°朝12点顺时针' })];
    const interactionMessages = [
        child(0x100, '选手端删除图层', 2, [u8('delete_type', { enum: { 0: '空操作', 1: '删除图层', 2: '删除所有' } }), u8('layer', { description: '图层数0–9' })]),
        ...[[0x101, 1], [0x102, 2], [0x103, 5], [0x104, 7]].map(([command, count]) =>
            child(command, `选手端绘制${count}个图形`, count * 15,
                [field('interaction_figure', 'struct', { ref: 'interaction_figure', count })])),
        child(0x110, '选手端绘制字符图形', 45, [field('graphic', 'struct', { ref: 'interaction_figure' }),
            raw('data', 30, { description: '原始字符字节，PDF未指定字符编码；图形details_b为字符长度' })],
        { notes: ['表1-32偏移0–5重复描述交互数据头；内容实际为15字节图形和30字节字符，共45字节。'] }),
        child(0x120, '哨兵自主决策指令', 4, [flags('sentry_cmd', 'uint32', [
            bit('confirm_respawn', 0), bit('confirm_instant_respawn', 1),
            bit('exchange_projectile_count', 2, 11, { description: '兑换发弹量，单调递增' }),
            bit('remote_projectile_exchange_requests', 13, 4, { description: '远程兑换发弹量请求次数，每次+1' }),
            bit('remote_hp_exchange_requests', 17, 4, { description: '远程兑换血量请求次数，每次+1' }),
            bit('stance', 21, 3, { enum: stances, description: '默认移动姿态（3）' }),
            bit('confirm_rune_activation', 24), bit('reserved', 25, 7, { type: 'reserved' })])]),
        child(0x121, '雷达自主决策指令', 8, [u8('radar_cmd', { description: '触发双倍易伤请求次数，每次+1' }),
            u8('password_cmd', { enum: { 1: '更新己方密钥', 2: '验证对方密钥' } }),
            field('password', 'string', { length: 6, encoding: 'ascii', description: '六位字母或数字密钥' })],
        { notes: ['表1-34对密钥区域的ASCII描述包含指令字节；按结构定义使用uint8指令（1/2）及6个ASCII密钥字符。'] }),
        { id: 'rm2026.0301.robot-communication', name: '机器人间自定义通信', commandRange: [0x200, 0x2ff],
            maxLength: 112, fields: [raw('user_data', undefined, { description: '机器人间自定义内容，最多112字节' })] }
    ];
    const eventBits = [
        bit('supply_zone_nonoverlap', 0), bit('reserved_supply', 1, 1, { type: 'reserved' }), bit('supply_zone_rmul', 2),
        bit('small_rune', 3, 2, { enum: { 0: '未激活', 1: '已激活', 2: '正在激活' } }),
        bit('large_rune', 5, 2, { enum: { 0: '未激活', 1: '已激活', 2: '正在激活' } }),
        bit('central_highland', 7, 2, { enum: occupied }), bit('trapezoid_highland', 9, 2),
        bit('enemy_dart_hit_time', 11, 9, { unit: 's' }), bit('enemy_dart_target', 20, 3, { enum: targetEnum }),
        bit('central_buff', 23, 2, { enum: sharedOccupied }), bit('fortress_buff', 25, 2, { enum: sharedOccupied }),
        bit('outpost_buff', 27, 2, { enum: occupied }), bit('base_buff', 29), bit('reserved', 30, 2)
    ];
    const rfidNames = ['ally_base', 'ally_central_highland', 'enemy_central_highland',
        'ally_trapezoid_highland', 'enemy_trapezoid_highland', 'ally_fly_slope_before', 'ally_fly_slope_after',
        'enemy_fly_slope_before', 'enemy_fly_slope_after', 'ally_central_lower', 'ally_central_upper',
        'enemy_central_lower', 'enemy_central_upper', 'ally_highway_lower', 'ally_highway_upper',
        'enemy_highway_lower', 'enemy_highway_upper', 'ally_fortress', 'ally_outpost',
        'ally_supply_nonoverlap_or_rmul', 'ally_supply_overlap', 'ally_assembly', 'enemy_assembly',
        'central_buff_rmul', 'enemy_fortress', 'enemy_outpost', 'ally_tunnel_highway_lower',
        'ally_tunnel_highway_middle', 'ally_tunnel_highway_upper',
        'ally_tunnel_trapezoid_lower', 'ally_tunnel_trapezoid_middle', 'ally_tunnel_trapezoid_upper'];
    const hp = ['ally_1_robot_HP', 'ally_2_robot_HP', 'ally_3_robot_HP', 'ally_4_robot_HP', 'damage_difference',
        'ally_7_robot_HP', 'ally_outpost_HP', 'ally_base_HP', 'enemy_outpost_HP', 'enemy_base_HP']
        .map(name => field(name,name === 'damage_difference' ? 'int16' : 'uint16'));
    const radarLink = { link: '雷达无线链路', frequency: '10Hz', direction: '信号发射源→雷达',
        notes: ['文档按字节大小与非负含义描述，数值字段采用无符号整数。'] };
    const enemyOccupied = { 0: '未占领', 1: '对方占领', 2: '己方占领' };
    const messages = [
        message(0x0001, '比赛状态数据', 11, [flags('game_type_progress', 'uint8', [
            bit('game_type', 0, 4, { enum: { 1: '超级对抗赛', 2: '高校单项赛', 3: 'ICRA人工智能挑战赛', 4: '联盟赛3V3', 5: '联盟赛步兵对抗' } }),
            bit('game_progress', 4, 4, { enum: { 0: '未开始', 1: '准备阶段', 2: '十五秒裁判系统自检', 3: '五秒倒计时', 4: '比赛中', 5: '比赛结算中' } })]),
        u16('stage_remain_time', { unit: 's' }), field('SyncTimeStamp', 'uint64', { description: 'UNIX时间；正确连接裁判系统NTP服务器后生效' })], { frequency: '1Hz', direction: '服务器→全体机器人' }),
        message(0x0002, '比赛结果数据', 1, [u8('winner', { enum: { 0: '平局', 1: '红方胜利', 2: '蓝方胜利' } })], { frequency: '比赛结束触发', direction: '服务器→全体机器人' }),
        message(0x0003, '机器人血量数据', 20, hp, { frequency: '3Hz', direction: '服务器→全体机器人' }),
        message(0x0101, '场地事件数据', 4, [flags('event_data', 'uint32', eventBits)], { frequency: '1Hz', direction: '服务器→己方全体机器人' }),
        message(0x0104, '裁判警告数据', 3, [u8('level', { enum: { 1: '双方黄牌', 2: '黄牌', 3: '红牌', 4: '判负' } }),
            u8('offending_robot_id'), u8('count')], { frequency: '判罚时触发，其余1Hz' }),
        message(0x0105, '飞镖发射相关数据', 3, [u8('dart_remaining_time', { unit: 's' }),
            flags('dart_info', 'uint16', [bit('last_hit_target', 0, 3, { enum: targetEnum }),
                bit('target_hit_count', 3, 3), bit('selected_target', 6, 3,
                    { enum: { 0: '未选择/前哨站', 1: '基地固定目标', 2: '基地随机固定目标', 3: '基地随机移动目标', 4: '基地末端移动目标' } }),
                bit('reserved', 9, 7, { type: 'reserved' })])], { frequency: '1Hz' }),
        message(0x0201, '机器人性能体系数据', 17, [u8('robot_id'), u8('robot_level'),
            u16('current_HP'), u16('maximum_HP'), u16('shooter_barrel_cooling_value'),
            u16('shooter_barrel_heat_limit'), u16('chassis_power_limit', { unit: 'W' }), f32('bullet_speed_limit', { unit: 'm/s' }),
            flags('power_management', 'uint8', [bit('gimbal_output', 0), bit('chassis_output', 1),
                bit('shooter_output', 2), bit('reserved', 3, 5)])], { frequency: '10Hz' }),
        message(0x0202, '实时底盘缓冲能量和射击热量数据', 14, [u16('reserved_1'), u16('reserved_2'),
            f32('reserved_3'), u16('buffer_energy', { unit: 'J' }), u16('shooter_17mm_1_barrel_heat'),
            u16('shooter_42mm_barrel_heat')], { frequency: '10Hz' }),
        message(0x0203, '机器人位置数据', 12, [f32('x', { unit: 'm' }), f32('y', { unit: 'm' }),
            f32('angle', { unit: '°', description: '正北为0度' })], { frequency: '1Hz',
            ...conflict('表1-5命令概览标为16字节；表1-14及robot_pos_t只有x、y、angle三个float，共12字节。') }),
        message(0x0204, '机器人增益和底盘能量数据', 8, [u8('recovery_buff', { unit: '%' }),
            u16('cooling_buff'), u8('defence_buff', { unit: '%' }), u8('vulnerability_buff', { unit: '%' }),
            u16('attack_buff', { unit: '%' }), flags('remaining_energy', 'uint8', [
                bit('at_least_125_percent', 0), bit('at_least_100_percent', 1), bit('at_least_50_percent', 2),
                bit('at_least_30_percent', 3), bit('at_least_15_percent', 4), bit('at_least_5_percent', 5),
                bit('at_least_1_percent', 6), bit('unspecified', 7, 1, { type: 'reserved', description: '文档未定义此位含义，保留原始值' })])], { frequency: '3Hz' }),
        message(0x0206, '伤害状态数据', 1, [flags('hurt', 'uint8', [bit('armor_id', 0, 4),
            bit('HP_deduction_reason', 4, 4, { enum: { 0: '弹丸攻击', 1: '装甲/超级电容模块离线', 5: '装甲撞击' } })])], { frequency: '伤害触发' }),
        message(0x0207, '实时射击数据', 7, [u8('bullet_type', { enum: { 1: '17mm', 2: '42mm' },
            description: '表1-17写作bit1/bit2；以uint8_t类型的值1/2保留原始值' }),
        u8('shooter_number', { enum: { 1: '17mm发射机构', 2: '保留', 3: '42mm发射机构' } }),
        u8('launching_frequency', { unit: 'Hz' }), f32('initial_speed', { unit: 'm/s' })], { frequency: '弹丸发射触发' }),
        message(0x0208, '允许发弹量', 8, [u16('projectile_allowance_17mm'), u16('projectile_allowance_42mm'),
            u16('remaining_gold_coin'), u16('projectile_allowance_fortress')], { frequency: '10Hz' }),
        message(0x0209, '机器人RFID模块状态', 5, [flags('rfid_status', 'uint32', rfidNames.map((name, index) => bit(name, index))),
            flags('rfid_status_2', 'uint8', [
                bit('enemy_tunnel_highway_lower', 0, 1, { id: 'rm2026.0209.rfid_status.enemy_tunnel_highway_lower' }),
                bit('enemy_tunnel_highway_middle', 1),
                bit('enemy_tunnel_highway_upper', 2, 1, { id: 'rm2026.0209.rfid_status.enemy_tunnel_highway_upper' }),
                bit('enemy_tunnel_trapezoid_lower', 3), bit('enemy_tunnel_trapezoid_middle', 4),
                bit('enemy_tunnel_trapezoid_upper', 5), bit('unspecified', 6, 2, { type: 'reserved' })])],
        { frequency: '3Hz', description: '非比赛状态下所有RFID标志均为0；隧道各增益点按V2.0.0重新分配' }),
        message(0x020a, '飞镖选手端指令数据', 6, [u8('dart_launch_opening_status', { enum: { 0: '已开启', 1: '关闭', 2: '开闭过程中' } }),
            u8('reserved'), u16('target_change_time', { unit: 's' }), u16('latest_launch_cmd_time', { unit: 's' })], { frequency: '3Hz' }),
        message(0x020b, '地面机器人位置数据', 40, ['hero_x', 'hero_y', 'engineer_x', 'engineer_y',
            'standard_3_x', 'standard_3_y', 'standard_4_x', 'standard_4_y', 'reserved_1', 'reserved_2'].map(name => f32(name, { unit: 'm' })),
        { frequency: '1Hz', description: '红方补给站附近围挡交点为原点；长边朝蓝方为X正向，短边朝红方停机坪为Y正向' }),
        message(0x020c, '雷达标记进度数据', 2, [flags('mark_progress', 'uint16', [
            ...['enemy_hero_vulnerable', 'enemy_engineer_vulnerable', 'enemy_standard_3_vulnerable',
                'enemy_standard_4_vulnerable', 'enemy_aerial_marked', 'enemy_sentry_vulnerable', 'ally_hero_marked', 'ally_engineer_marked',
                'ally_standard_3_marked', 'ally_standard_4_marked', 'ally_aerial_marked', 'ally_sentry_marked',
                'enemy_aerial_targeted_by_ally_radar_laser','enemy_aerial_countered',
                'ally_aerial_targeted_by_enemy_radar_laser','ally_aerial_countered'].map((name, index) => bit(name, index))])],
        { frequency: '1Hz', description: '标记位：对方进度≥100/己方进度≥50时置1；bit12–15分别为激光照射与反制状态' }),
        message(0x020d, '哨兵自主决策信息同步', 14, [flags('sentry_info', 'uint32', [
            bit('exchanged_projectile_count', 0, 11), bit('remote_projectile_exchange_count', 11, 4),
            bit('remote_hp_exchange_count', 15, 4), bit('can_confirm_free_respawn', 19),
            bit('can_exchange_instant_respawn', 20), bit('instant_respawn_gold_cost', 21, 10), bit('reserved', 31)]),
        flags('sentry_info_2', 'uint16', [bit('is_disengaged', 0), bit('remaining_team_17mm_exchange_allowance', 1, 11), bit('stance', 12, 2,
            { enum: { 1: '进攻', 2: '防御', 3: '移动' } }), bit('can_activate_rune', 14), bit('strengthened_stance', 15)]),
        flags('sentry_info_3','uint64',[
            bit('attack_seconds',0,8),bit('defence_seconds',8,8),bit('movement_seconds',16,8),bit('reserved_low',24,8,{type:'reserved'}),
            bit('strengthened_attack_seconds',32,8),bit('strengthened_defence_seconds',40,8),bit('strengthened_movement_seconds',48,8),
            bit('reserved_high',56,8,{type:'reserved'})])], { frequency: '1Hz' }),
        message(0x020e, '雷达自主决策信息同步', 1, [flags('radar_info', 'uint8', [bit('double_vulnerability_chances', 0, 2),
            bit('enemy_double_vulnerability_active', 2), bit('encryption_level', 3, 2), bit('can_change_password', 5), bit('reserved', 6, 2)])], { frequency: '1Hz' }),
        message(0x0301, '机器人交互数据', undefined, [u16('data_cmd_id'), u16('sender_id'), u16('receiver_id')],
            { maxLength: 118, frequency: '≤30Hz', dispatch: { field: 'data_cmd_id', offset: 6, name: 'content', messages: interactionMessages },
                description: '整包≤127字节；内容≤112字节；机器人间仅己方通信；雷达可发给任意己方选手端，其余仅对应操作手；每1000ms接收上限：常规兵种3720字节、雷达与哨兵5120字节' }),
        message(0x0302, '自定义控制器与机器人交互数据', 30, [raw('data', 30)], { link: '图传链路', frequency: '≤30Hz' }),
        message(0x0303, '选手端小地图交互数据', 12, [f32('target_position_x', { unit: 'm' }), f32('target_position_y', { unit: 'm' }),
            u8('cmd_keyboard'), u8('target_robot_id'), u16('cmd_source')], { frequency: '云台手≥0.5s；半自动控制≥3s；重复发送机制见第33页',
            ...conflict('表1-5命令概览标为15字节；表1-35及map_command_t两个float、两个uint8、一个uint16，共12字节。') }),
        message(0x0305, '选手端小地图接收雷达数据', 48, [...positions('opponent',true),...positions('ally')],
            { frequency: '≤5Hz', description: '先对方后己方，各含英雄、工程、3/4号步兵、空中、哨兵；单位cm，坐标均为0表示未发送' }),
        message(0x0306, '自定义控制器与选手端交互数据', 8, [flags('key_value', 'uint16', [bit('key_1', 0, 8), bit('key_2', 8, 8)]),
            flags('mouse_x', 'uint16', [bit('x_position', 0, 12), bit('mouse_left', 12, 4)]),
            flags('mouse_y', 'uint16', [bit('y_position', 0, 12), bit('mouse_right', 12, 4)]), u16('reserved')],
        { link: '非链路', frequency: '≤30Hz', description: '鼠标左上角原点1920×1080；按键状态1为按下，其他为未按下' }),
        message(0x0307, '选手端小地图接收路径数据', 105, [u8('intention', { enum: { 1: '到目标点攻击', 2: '到目标点防守', 3: '移动到目标点' } }),
            u16('start_position_x', { unit: 'dm' }), u16('start_position_y', { unit: 'dm' }),
            field('delta_x', 'int8', { count: 49, unit: 'dm' }), field('delta_y', 'int8', { count: 49, unit: 'dm' }), u16('sender_id')],
        { frequency: '≤1Hz', ...conflict('表1-5命令概览标为103字节；表1-37及map_data_t在偏移103还有2字节sender_id，实际详细布局为105字节。') }),
        message(0x0308, '选手端小地图接收机器人数据', 34, [u16('sender_id'), u16('receiver_id'),
            field('user_data', 'string', { length: 30, encoding: 'utf-16le', description: '15个UTF16码元，默认小端；可在自定义schema中改为utf-16be' })], { frequency: '≤3Hz' }),
        message(0x0309, '自定义控制器接收机器人数据', 30, [raw('data', 30)], { link: '图传链路', frequency: '≤10Hz' }),
        message(0x0310, '机器人发送给自定义客户端的数据', 300, [raw('data', 300)], { link: '图传链路', frequency: '≤50Hz', description: '数据量较大，不重传' }),
        message(0x0311, '自定义客户端发送给机器人的数据', 30, [raw('data', 30)], { link: '图传链路', frequency: '≤75Hz', description: '数据量较大，不重传' }),
        message(0x0a01, '对方机器人位置数据', 24, positions('opponent'), radarLink),
        message(0x0a02, '对方机器人血量数据', 12, ['hero','engineer','infantry_3','infantry_4','reserved','sentry']
            .map(kind=>u16(kind === 'reserved' ? 'reserved' : `opponent_${kind}_HP`)), radarLink),
        message(0x0a03, '对方机器人允许发弹量', 10, ['hero','infantry_3','infantry_4','aerial','sentry']
            .map(kind=>u16(`opponent_${kind}_projectile_allowance`)), radarLink),
        message(0x0a04, '对方金币与场地状态', 8, [u16('opponent_remaining_gold_coin'),u16('opponent_total_gold_coin'),
            flags('opponent_status','uint32',[
                bit('supply_zone',0),bit('central_highland',1,2,{enum:{1:'对方占领',2:'己方占领'}}),bit('trapezoid_highland',3),
                bit('fortress_buff',4,2,{enum:{...enemyOccupied,3:'双方占领'}}),bit('outpost_buff',6,2,{enum:enemyOccupied}),bit('base_buff',8),
                bit('tunnel_center_enemy_before_slope',9),bit('tunnel_center_enemy_after_slope',10),
                bit('tunnel_center_ally_before_slope',11),bit('tunnel_center_ally_after_slope',12),
                bit('crossing_highland_upper',13),bit('crossing_slope_after',14),bit('crossing_highway_upper',15),
                bit('unspecified',16,16,{type:'reserved',description:'文档未定义高16位，保留原始值'})])], radarLink),
        message(0x0a05, '对方机器人增益与状态', 41, [
            ...['hero','engineer','infantry_3','infantry_4','sentry'].flatMap(kind=>[
                u8(`${kind}_recovery_buff`,{unit:'%'}),u16(`${kind}_cooling_buff`),u8(`${kind}_defence_buff`,{unit:'%'}),
                u8(`${kind}_vulnerability_buff`,{unit:'%',description:'无符号幅值，30表示负防御30%'}),u16(`${kind}_attack_buff`,{unit:'%'})]),
            u8('sentry_stance',{enum:stances}),
            ...['hero','engineer','infantry_3','infantry_4','sentry'].map(kind=>u8(`${kind}_status`,
                {enum:{0:'存活',1:'战亡',2:'无敌但不虚弱',3:'无敌且虚弱'}}))], radarLink),
        message(0x0a06, '对方干扰波密钥', 6, [field('password','string',{length:6,encoding:'ascii'})], radarLink)
    ];
    const schema = {
        // The original namespace is a stable identity, not the document version.
        id: 'robomaster-2026-v1', name: 'RoboMaster 2026 串口协议 V2.0.0', version: source.version,
        description: '基于官方V2.0.0第1章串口协议（4–43页）及CRC附录（75–78页）；data_length = LEN(payload)，不包含末尾2字节CRC16。',
        endian: 'little', framing: { header: [0xa5], length: { offset: 1, type: 'uint16', adjustment: 9 }, maxLength: 65544 },
        headerFields: [u8('SOF', { offset: 0 }), u16('data_length', { offset: 1, description: '仅data数据段长度，不包含cmd_id和末尾CRC16；整帧长度为本值 + 9。' }),
            u8('rm_seq', { id: 'robomaster-2026-v1.header.seq', offset: 3, valueSource: 'SEQ' }), u8('CRC8', { offset: 4 })],
        command: { offset: 5, type: 'uint16' }, payloadOffset: 7, payloadEnd: -2,
        checksums: [
            { id: 'header-crc8', type: 'crc', width: 8, polynomial: 0x31, init: 0xff,
                reflectIn: true, reflectOut: true, xorOut: 0, start: 0, end: 4, offset: 4 },
            { id: 'frame-crc16', type: 'crc', width: 16, polynomial: 0x1021, init: 0xffff,
                reflectIn: true, reflectOut: true, xorOut: 0, start: 0, end: -2, offset: -2, endian: 'little' }
        ], structures: { interaction_figure: graphic }, messages,
        source, serial: { regularBaud: 115200, videoBaud: 921600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }
    };
    const legacyCompiled = Protocol.compile(schema);
    const preset = ProtocolModel.toUnified(legacyCompiled.schema), whole = preset.messages[0];
    const header = whole.fields.find(field => field.name === 'header');
    const payload = whole.fields.find(field => field.name === 'payload');
    const length = header.fields.find(field => field.name === 'data_length');
    // Explicit inspector presentation; IDs, byte constraints and rule references stay unchanged.
    for (const field of header.fields) if (field.expectedBytes) field.contentConstraint = 'fixed';
    // Known command layouts consume their own fields. Only unresolved branches
    // use the explicitly enabled value equation to obtain the payload boundary.
    delete whole.lengthSource;
    delete whole.lengthFrom;
    delete payload.lengthSource;
    payload.lengthFrom = 'contents';
    const structural = fields => { for (const field of fields ?? []) {
        if (['struct','choice'].includes(field.type) && field.lengthFrom === 'REMAINING') field.lengthFrom = 'contents';
        structural(field.fields);
        for (const branch of field.branches ?? []) structural(branch.fields);
    } };
    structural(payload.branches.flatMap(branch => branch.fields));
    length.description = 'payload 的实际字节数，不包含checksum_0。结构明确时仅验证；变长分支按值表达式求解边界，发送按实际字节回填。';
    length.contentConstraint = 'length';
    preset.rules = [{ id: 'robomaster-2026-v1-data-length-rule', name: '数据段长度验证', type: 'length',
        stage: 'validation', strength: 'weak', send: 'fill', enabled: true,
        targetFieldId: length.id, boundaryFallback: true, value: 'LEN(payload)',
        expression: 'header.data_length == LEN(payload)' }];
    for (const field of [...header.fields, ...whole.fields]) if (field.type === 'checksum') {
        const isHeader = field.name === 'CRC8';
        field.contentConstraint = 'checksum';
        field.checksum.start = { fieldId: isHeader ? header.fields[0].id : header.id, edge: 'start' };
        field.checksum.end = { fieldId: isHeader ? header.fields.find(item => item.name === 'rm_seq').id : payload.id, edge: 'end' };
        preset.rules.push({ id: field.id + '-rule', name: isHeader ? '帧头 CRC8' : '整帧 CRC16', type: 'checksum',
            stage: isHeader ? 'both' : 'validation', strength: 'strong', send: 'fill', enabled: true,
            targetFieldId: field.id, checksum: field.checksum });
        field.type = 'uint' + field.byteLength * 8; delete field.checksum;
    }
    const compiled = Protocol.compile(preset), canonicalSchema = compiled.schema;
    const RoboMasterProtocol = { schema: canonicalSchema, preset: canonicalSchema, compiled, source,
        // Keep the former representation available for explicit legacy imports
        // and migration checks; new presets always use the independent rules.
        legacySchema: legacyCompiled.schema,
        commands: legacyCompiled.messages.map(item => ({ id: item.id, name: item.name, command: item.command,
            commandRange: item.commandRange, parentMessageId: item.parent?.id, length: item.length,
            requireLayout: item.requireLayout === true, conflicts: item.conflicts || [] })),
        compile: (customSchema = canonicalSchema) => Protocol.compile(customSchema),
        createSchema: () => JSON.parse(JSON.stringify(canonicalSchema)),
        createParser: (customSchema = compiled) => new Protocol.StreamParser(customSchema) };
    root.SerialPlotter ??= {}; root.SerialPlotter.RoboMasterProtocol = RoboMasterProtocol;
    if (typeof module !== 'undefined' && module.exports) module.exports = { RoboMasterProtocol };
})(globalThis);
