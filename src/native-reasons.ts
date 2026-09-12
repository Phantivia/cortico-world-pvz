/**
 * 植入件 `reason` 原文 → 一句确切中文。
 *
 * 原生只会说英文调试串,回执里给她的必须是「到底发生了什么」。分两张表是因为同一条串
 * 还得回答第二个问题:这一步对世界做了什么。`FAILED` 的每一条都是「没有生效」;
 * `UNVERIFIABLE` 的每一条是「输入已经进了游戏,效果确证不了」——只有这一类才配叫未验真。
 *
 * 覆盖由 `tests/worlds/pvz/native-reasons.test.ts` 从 `native/*.h`、`implant.cpp` 里逐条抽出比对:
 * 原生改一个词,测试红,而不是回执悄悄退回兜底句。
 */

export type PvzNativeCertainty = 'failed' | 'unknown';

export interface PvzNativeReason {
  text: string;
  certainty: PvzNativeCertainty;
}

/** 这一步没有对游戏产生效果。 */
const FAILED: Record<string, string> = {
  // 相对种植 · 解析
  'aheadOf is only supported for plant actions': '只有种植步骤能用 aheadOf',
  'plant slot and row must be integers within the board limits': '卡位与排号必须是棋盘范围内的整数',
  'plant requires an integer column or aheadOf': '种植要么给整数列号，要么给 aheadOf',
  'plant column and aheadOf are mutually exclusive': '列号与 aheadOf 只能给一个',
  'aheadOf must be an object containing minGap': 'aheadOf 必须是带 minGap 的对象',
  'aheadOf must contain only minGap': 'aheadOf 只收 minGap 一个字段',
  'aheadOf.minGap must be an integer from 0 through 8': 'aheadOf.minGap 必须是 0 到 8 的整数',
  'malformed aheadOf selector': 'aheadOf 的写法不合法',

  // 相对种植 · 入口闸
  'relative planting slot is outside the seed bank': '卡位超出卡槽范围',
  'relative planting row is outside this board': '这一排不在当前棋盘上',
  'relative planting slot is not present in the seed bank': '这个卡位当前不在卡槽里',
  'relative planting slot does not hold the plant the action asked for': '这个卡位上不是这一步要的植物',
  'relative planting board is paused': '棋盘处在暂停中',
  'relative planting seed packet is not active in the seed bank': '这张卡当前不可用',
  'relative planting seed packet is still on cooldown': '这张卡还在冷却里',
  'relative planting seed packet costs more sun than is available': '阳光不够买这张卡',
  'relative planting could not verify the seed packet identity': '核不准这个卡位上是哪一张卡',
  'board state could not be verified': '读不到可信的棋盘状态',

  // 相对种植 · 绑定目标
  'relative planting could not read a hostile position in the requested row': '读不到这一排僵尸的位置',
  'relative planting found no visible living hostile in the requested row': '这一排没有看得见的活僵尸',
  'relative planting nearest hostile is off the ground': '这一排最近的僵尸不在地面上',
  'relative planting nearest hostile is moving away from the house': '这一排最近的僵尸正在朝离开房子的方向走',
  'relative planting nearest hostile is in a phase with no known houseward direction': '这一排最近的僵尸处在判不出朝向的动作里',
  'relative planting could not identify the current run': '认不出当前这一局',

  // 相对种植 · 棋盘重读
  'relative planting moved to a different board instance': '中途换成了另一个棋盘',
  'relative planting could not re-read the board': '中途重读不到棋盘',
  'relative planting level changed': '中途换了关卡',
  'relative planting board counter restarted': '中途棋盘计数重启了',
  'relative planting level ended': '中途关卡结束了',
  'relative planting level entered its end-of-level transition': '中途关卡进了结算过场',
  'relative planting run changed': '中途换了一局',
  'board is not active': '当前没有进行中的棋盘',
  'board input is unavailable while another screen is active': '有别的界面盖在棋盘上，棋盘不收输入',
  'board input is unavailable during the dark storm phase': '暴风雨暗场阶段棋盘不收输入',
  'LawnApp is not initialized': '游戏主对象还没初始化',
  'live LawnApp vtable mismatch': '游戏主对象的虚表跟植入件对不上',

  // 相对种植 · 动作生命周期
  'relative planting was cancelled': '这一步在点下去之前被取消了',
  'relative planting exceeded its time budget': '这一步用光了它的时间预算',

  // 相对种植 · 锁定目标
  'relative planting target is no longer visible': '锁定的那只僵尸不见了',
  'relative planting target moved to another row': '锁定的那只僵尸换排了',
  'relative planting target was charmed': '锁定的那只僵尸被魅惑了',
  'relative planting target is dying': '锁定的那只僵尸正在死',
  'relative planting target left the ground': '锁定的那只僵尸离开了地面',
  'relative planting target turned away from the house': '锁定的那只僵尸掉头朝离开房子走了',
  'relative planting target entered a phase with no known houseward direction': '锁定的那只僵尸进了判不出朝向的动作',

  // 相对种植 · 落点格
  'relative planting cell is outside the board': '算出来的落点在棋盘外',
  'relative planting board stopped disclosing entities': '棋盘中途不再公开实体',
  'relative planting cell is behind fog': '落点在迷雾里',
  'relative planting found no cell ahead of the target that takes this plant': '从那只僵尸脚下往屋方向没有一格能下这株植物',

  // 相对种植 · 卡片
  'relative planting seed slot left the seed bank': '绑定的卡位从卡槽里消失了',
  'relative planting seed packet could not be re-read': '中途重读不到这张卡',
  'relative planting seed bank was rebuilt': '卡槽被整个重建了',
  'relative planting seed slot no longer holds the bound plant': '绑定的卡位换成了别的植物',
  'relative planting seed packet was already spent': '这张卡已经被用掉了',
  'relative planting conveyor advanced past the bound seed packet': '传送带把绑定的那张卡送走了',
  'relative planting cursor is no longer holding a seed packet': '光标上已经没有卡了',
  'relative planting cursor is holding a different seed packet': '光标上拿的是另一张卡',

  // 相对种植 · 选卡序列
  'relative planting seed-bank click could not be posted': '点卡槽的输入发不出去',
  'relative planting cursor picked up a different seed packet': '光标拿起来的是另一张卡',
  'relative planting cursor was taken by another tool': '光标被别的工具占走了',
  'relative planting seed packet did not reach the cursor in time': '这张卡没能在时限内到光标上',
  'relative planting cursor movement was interrupted': '光标移动中途被打断',
  'relative planting target crossed cells beyond the cursor correction limit': '僵尸跨的格数超出了光标能追的上限',

  // 相对种植 · 派发与提交
  'relative planting window is not at its managed client size': '游戏窗口不是受管的 800×600',
  'relative planting point is outside the managed client area': '落点算在窗口画面区外',
  'relative planting could not install the internal mouse dispatch': '装不上内部鼠标派发',
  'relative planting request was withdrawn before the click': '点下去之前这一步被撤回了',
  'relative planting lost the game process while dispatching': '派发途中游戏进程没了',
  'relative planting could not reach the widget manager': '够不到游戏的控件管理器',
  'relative planting request was superseded before the game thread handled it': '游戏线程处理之前，这一步被后来的请求顶掉了',
  'relative planting click was not accepted by the game': '游戏没有接住这一次点击',
  'relative planting seed packet was not observed being consumed': '点下去之后没有看到这张卡被消耗',

  // 绝对种植
  'planting slot is outside the seed bank': '卡位超出卡槽范围',
  'planting cell is outside this board': '这一格不在当前棋盘上',
  'planting slot is not present in the seed bank': '这个卡位当前不在卡槽里',
  'planting slot does not hold the plant the action asked for': '这个卡位上不是这一步要的植物',
  'planting board is paused': '棋盘处在暂停中',
  'planting seed packet is not active in the seed bank': '这张卡当前不可用',
  'planting seed packet is still on cooldown': '这张卡还在冷却里',
  'planting seed packet costs more sun than is available': '阳光不够买这张卡',
  'planting cell will not take this plant': '这一格不收这株植物',
  'seed bank packet identity could not be verified': '核不准卡槽上是哪一张卡',
  'selected seed packet did not enter the planting cursor': '选中的卡没有进到种植光标上',
  'seed packet was not observed being consumed by the requested planting input': '点下去之后没有看到这张卡被消耗',
  'failed to post seed-bank selection input': '点卡槽的输入发不出去',
  'failed to post planting-cell input': '点格子的输入发不出去',

  // 铲子
  'shovel cell is invalid': '铲子的目标格不合法',
  'shovel target state is unavailable': '读不到铲子目标格的状态',
  'shovel is blocked while another cursor tool is held': '光标上还拿着别的工具，铲不了',
  'shovel selection is blocked by another cursor tool': '光标上还拿着别的工具，拿不了铲子',
  'no visible plant exists at the requested cell': '这一格上没有看得见的植物',
  'the requested plant was not observed leaving the cell after shovel input': '铲下去之后没有看到那株植物离开这一格',
  'failed to post shovel selection input': '拿铲子的输入发不出去',
  'failed to post shovel-cell input': '铲格子的输入发不出去',

  // 收取
  'collectibles are unavailable while the board is inactive or paused': '棋盘不在进行中或已暂停，收不了',
  'no collectible ids were supplied': '没有给任何目标 id',
  'collectible ids must be an array of at most 128 integers': '目标 id 必须是最多 128 个整数的数组',
  'collectible ids must be unique': '目标 id 不能重复',
  'collectible ids are outside the supported range': '目标 id 超出支持范围',
  'one or more collectibles are no longer visible': '有目标已经看不见了',
  'a requested collectible disappeared before it could be clicked': '有个要收的目标在点到之前就没了',
  'collectible did not enter the collection state before timeout': '时限内没有看到这个目标进入被收取的状态',
  'collectible input stopped because the board run changed': '这一局换了，收取中途停下',
  'collectible input stopped because the board screen changed': '棋盘画面变了，收取中途停下',
  'failed to post collectible input from a current target': '收取目标的输入发不出去',

  // 锤击
  'no selected surfaced whack target is currently visible': '选中的那个冒头目标当前看不见',
  'selected Whack-a-Zombie targets are blocked by collectible hit regions': '选中的锤击目标被可收集物的点击区挡住了',
  'selected Whack-a-Zombie targets did not show a hit effect': '锤下去之后选中的目标没有出现被打中的效果',
  'whack batch level scope is stale': '这批锤击绑定的关卡已过期',
  'whack batch stopped because the board scope changed': '棋盘换了，这批锤击中途停下',
  'whack batch stopped because the bound level changed': '绑定的关卡换了，这批锤击中途停下',
  'whack targetIds require expectedLevel': '给 targetIds 就必须同时给 expectedLevel',
  'whack targetIds must be an integer array': 'targetIds 必须是整数数组',
  'whack targetIds must be unique': 'targetIds 不能重复',
  'whack targetIds must contain 1 to 32 nonnegative integers': 'targetIds 要给 1 到 32 个非负整数',
  'expectedLevel must be a nonnegative integer': 'expectedLevel 必须是非负整数',

  // 特殊动作
  'unknown special action': '认不出的特殊动作',
  'special cell action is unavailable or invalid': '这项按格子的特殊动作当前不可用，或者参数不合法',
  'special action is not currently offered for this target': '这个目标当前没有提供这项特殊动作',
  'card-based special action is unavailable': '这项用卡的特殊动作当前不可用',
  'card-based special action is unavailable or invalid': '这项用卡的特殊动作当前不可用，或者参数不合法',
  'card-based special packet identity could not be verified': '核不准这项特殊动作用的是哪张卡',
  'failed to post card-based special input': '这项用卡特殊动作的输入发不出去',
  'no verified usable-seed packet is ready to launch': '没有核验过、可以发射的道具卡',
  'usable seed was not observed being consumed at the requested cell': '没有看到道具卡在这一格被消耗',
  'failed to post usable-seed input': '道具卡的输入发不出去',
  'bowling packet consumption and rolling plant were not both observed': '保龄球的卡消耗与滚动植物没有同时出现',
  'no vase exists at the requested cell': '这一格上没有花瓶',
  'failed to post vase input': '打花瓶的输入发不出去',
  'cob cannon source or destination is invalid': '玉米加农炮的起点或落点不合法',
  'cob cannon source is absent or reloading': '起点的玉米加农炮不在，或者还在装填',
  'cob cannon target id is absent or reloading': '目标玉米加农炮不在，或者还在装填',
  'cob cannon did not become ready to aim': '玉米加农炮没有进到可瞄准的状态',
  'cob cannon source remained ready after target input': '点完落点，玉米加农炮仍是待发状态',
  'failed to select cob cannon': '选中玉米加农炮失败',

  // 小游戏
  'Beghouled action is unavailable or invalid': '宝石迷阵这一步当前不可用，或者参数不合法',
  'Beghouled purchase is unavailable while the board is moving': '棋盘还在动，宝石迷阵不接受购买',
  'Beghouled purchase card is no longer usable': '宝石迷阵的这张购买卡已经不能用了',
  'Beghouled purchase effect was not observed': '没有看到宝石迷阵的购买生效',
  'Beghouled source has no visible plant': '宝石迷阵的起点格上没有看得见的植物',
  'failed to post Beghouled drag input': '宝石迷阵的拖动输入发不出去',
  'failed to post Beghouled purchase input': '宝石迷阵的购买输入发不出去',
  'failed to post Beghouled twist input': '宝石迷阵的旋转输入发不出去',
  'I-Zombie card is not legal on that side of the placement line': '我是僵尸：这张卡不能放在放置线的这一侧',
  'I-Zombie placement was not observed': '没有看到我是僵尸的放置生效',
  'Last Stand is not waiting to start an onslaught': '坚不可摧当前不在等待开始进攻',
  'Last Stand did not enter the onslaught state': '坚不可摧没有进到进攻阶段',
  'failed to post Last Stand input': '坚不可摧的输入发不出去',
  'Zombiquarium seed bank is unavailable': '僵尸水族馆的卡槽读不到',
  'Zombiquarium cannot accept a brain at that target': '僵尸水族馆这个位置不能放脑子',
  'Zombiquarium brain placement was not observed': '没有看到脑子被放进僵尸水族馆',
  'Zombiquarium purchase is no longer available': '僵尸水族馆的这项购买已经不可用',
  'Zombiquarium snorkel purchase was not observed': '没有看到潜水僵尸买成',
  'Zombiquarium trophy purchase was not observed': '没有看到奖杯买成',
  'failed to post Zombiquarium feeding input': '僵尸水族馆的喂食输入发不出去',
  'failed to post Zombiquarium purchase input': '僵尸水族馆的购买输入发不出去',
  'slot machine is not ready to spin': '老虎机当前不能拉',
  'slot-machine handle position is unavailable': '读不到老虎机拉杆的位置',
  'slot-machine spin did not complete the 0-4-0 transition': '老虎机这一拉没有走完 0-4-0 的状态变化',
  'failed to post slot-machine input': '拉老虎机的输入发不出去',

  // 禅境花园
  'Zen Garden board state became unavailable': '禅境花园的状态读不到了',
  'Zen care action is unavailable in the current garden state': '当前花园状态下这项照料不可用',
  'Zen care target no longer shows the requested need': '这株植物已经不缺这一项了',
  'Zen care target changed before tool selection': '选工具之前照料目标就变了',
  'Zen care target changed after tool selection': '选好工具之后照料目标变了',
  'Zen toolbar did not become selectable after wake input': '唤醒之后禅境工具栏仍然不可选',
  'selected Zen care tool did not enter the expected cursor state': '选中的照料工具没有进到预期的光标状态',
  'gold watering can has no current visible watering targets': '金水壶当前没有看得见的浇水目标',
  'failed to select the current Zen care tool': '选中当前照料工具失败',
  'failed to apply the Zen care tool to the current plant': '照料工具没能作用到这株植物上',
  'failed to post the Zen toolbar wake input': '唤醒禅境工具栏的输入发不出去',
  'next garden is unavailable in the current state': '当前状态下不能切下一个花园',
  'no purchased destination garden is available': '没有已经买下的目标花园',
  'garden profile state is unavailable': '花园的档案状态读不到',
  'garden state changed before navigation input': '发切换输入之前花园状态就变了',
  'destination garden changed before input': '发输入之前目标花园就变了',
  'next-garden input did not reach the expected public garden state': '切换输入没有到达预期的花园状态',
  'failed to post next-garden input': '切换花园的输入发不出去',
  'Zen tutorial board state became unavailable': '禅境教程的状态读不到了',
  'Zen tutorial target became unavailable': '禅境教程的目标没了',
  'Zen tutorial target no longer needs the requested tool': '教程目标已经不需要这件工具了',
  'Zen tutorial input was cancelled': '禅境教程的输入被取消了',
  'Zen tutorial tool cursor was not observed': '没有看到教程工具进到光标上',
  'Zen tutorial tool effect was not observed': '没有看到教程工具生效',
  'failed to select the Zen tutorial tool': '选中禅境教程工具失败',
  'failed to apply the Zen tutorial tool': '教程工具没能用出去',
  'Zen Garden store exit did not enter the fertilizer tutorial': '退出商店没有进到肥料教程',
  'fertilizer purchase confirmation was not available': '肥料购买的确认框没有出现',
  'fertilizer inventory and coin debit were not observed': '肥料没有入库，金币也没有扣',
  'failed to post fertilizer item input': '肥料道具的输入发不出去',
  'Tree of Wisdom cannot currently accept tree food': '智慧树当前吃不下肥料',
  'Tree of Wisdom state changed after selecting tree food': '选好肥料之后智慧树的状态变了',
  'tree food did not enter the expected cursor state': '肥料没有进到预期的光标状态',
  'tree-food animation and height increase were not both verified': '喂肥的动画与长高没有同时出现',
  'failed to select currently available tree food': '选中当前可用的智慧树肥料失败',
  'failed to apply tree food to the visible tree': '肥料没能喂到智慧树上',

  // 选卡界面
  'seed chooser is not active or seed is invalid': '当前不在选卡界面，或者这张卡不合法',
  'seed chooser is not ready': '选卡界面还没准备好',
  'seed chooser start button is not enabled': '选卡界面的开始按钮不可点',
  'seed is not unlocked by the active profile': '当前档案还没解锁这张卡',
  'seed is not selectable in the current game mode': '当前模式下选不了这张卡',
  'seed is not currently selectable': '这张卡当前选不了',
  'seed is fixed by Crazy Dave and cannot be removed': '这张卡是戴夫钉住的，撤不掉',
  'selecting Imitater requires an imitated seed from 0 through 39': '选模仿者要给 0 到 39 的被模仿卡号',
  'imitates is valid only while selecting an unbanked Imitater': '只有在选还没入槽的模仿者时才能给 imitates',
  'expectedCardImitates must be an integer or null': 'expectedCardImitates 必须是整数或 null',
  'Imitater button is not currently enabled': '模仿者按钮当前不可点',
  'Imitater chooser did not open in a verified state': '模仿者选择框没有进到可核验的状态',
  'failed to open the Imitater chooser': '打开模仿者选择框失败',
  'failed to post Imitater selection input': '模仿者的选择输入发不出去',
  'failed to post seed chooser input': '选卡界面的输入发不出去',
  'failed to post ready input': '「Ready」的输入发不出去',

  // 菜单与档案
  'semantic menu context is stale': '提交用的菜单上下文已经过期',
  'menu target is not currently offered and enabled': '这个菜单项当前没有提供，或者不可点',
  'interaction target is not currently offered and enabled': '这个交互目标当前没有提供，或者不可点',
  'interaction did not produce a visible menu-state change': '这次交互没有引起任何可见的菜单状态变化',
  'failed to post interaction input': '交互输入发不出去',
  'failed to post menu mouse input': '菜单的鼠标输入发不出去',
  'title screen is no longer ready to continue': '标题画面已经不在可以继续的状态',
  'title screen did not advance after input': '点完之后标题画面没有往下走',
  'visual compatibility clicks are unavailable on unsettled or gameplay screens': '画面没稳定或正在游戏中，兼容性点击不可用',
  'failed to post visual compatibility input': '兼容性点击的输入发不出去',
  'the visible profile selection is unavailable': '读不到当前可见的档案选择',
  'profile row or confirmation changed before the click': '点下去之前档案行或确认按钮变了',
  'profile row selection was not verified': '没有核到档案行被选中',
  'selected profile did not become the active profile': '选中的档案没有成为当前档案',
  'profile creation is unavailable or the name is invalid': '当前不能建档案，或者这个名字不合法',
  'profile creation is not currently offered and enabled': '建档案当前没有提供，或者不可点',
  'profile creation is not available in the active dialog': '当前对话框里不能建档案',
  'profile creation confirmation did not accept input': '建档案的确认按钮没有接住输入',
  'the profile list does not offer a new-profile entry': '档案列表里没有「新建档案」这一项',
  'profile state changed while opening the name dialog': '打开命名对话框的过程中档案状态变了',
  'profile name dialog did not open from the profile list': '档案列表没有打开命名对话框',
  'profile name field is not ready': '档案名输入框还没准备好',
  'profile name field did not accept the supplied text': '档案名输入框没有接住输入的文字',
  'new active profile and roster growth were not both verified': '新档案没有同时核到「成为当前档案」和「档案列表变长」',
  'failed to open the profile name dialog': '打开档案命名对话框失败',
  'failed to focus the profile name field': '聚焦档案名输入框失败',
  'failed to clear the profile name field': '清空档案名输入框失败',
  'failed to enter the profile name': '输入档案名失败',

  // 传输、窗口与身份
  'malformed command envelope': '命令信封的格式不合法',
  'unknown action kind': '认不出的动作类型',
  'command strings exceed the 128-character limit': '命令里的字符串超过 128 字上限',
  'configure values are outside the supported range': 'configure 的取值超出支持范围',
  'duplicate command id': '命令 id 重复',
  'native action queue is full': '植入件的动作队列满了',
  'native bridge is stopping': '植入件正在停机',
  'input epoch is stale': '提交用的输入代次已经过期',
  'input epoch changed before execution': '执行之前输入代次变了，这一步作废',
  'cancelled before execution': '这一步在执行之前就被取消了',
  'Plants vs. Zombies window is not available': '找不到游戏窗口',
  'Plants vs. Zombies window is not ready': '游戏窗口还没准备好接输入',
  'Plants vs. Zombies window is minimized': '游戏窗口已经最小化',
  'failed to post the game close request': '关闭游戏的请求发不出去',
  'game window remained open after the close request': '发了关闭请求，游戏窗口仍然开着',
  'window capture failed': '窗口截图失败',
  'GDI+ initialization failed': 'GDI+ 初始化失败',
  'PNG encoding failed': 'PNG 编码失败',
  'base64 encoding failed': 'base64 编码失败',
  'cannot hash the executable': '算不出游戏可执行文件的哈希',
  'executable SHA-256 is not the pinned APAC JA 1073 build': '游戏可执行文件不是钉住的 APAC JA 1073 版',
  'image base is not 0x00400000': '游戏映像基址不是 0x00400000',
  'invalid DOS header': '游戏可执行文件的 DOS 头不合法',
  'PE identity or relocation policy mismatch': '游戏可执行文件的 PE 身份或重定位策略对不上',
  'critical LawnApp accessor signature mismatch': '关键的游戏访问器签名对不上',
};

/** 输入已经进了游戏,效果确证不了。 */
const UNVERIFIABLE: Record<string, string> = {
  'relative planting click was dispatched without an acknowledged result': '点击发出去了，游戏没回结果',
  'relative planting click result is unknown': '点击的结果不明',
  'relative planting release was not acknowledged': '按下去之后松开没有得到确认',
  'relative planting was cancelled after the click was delivered': '点击已经送进游戏，之后这一步才被取消',
  'planting result could not be verified after the board screen changed': '棋盘画面变了，种植结果核不了',
  'bowling result could not be verified after the board screen changed': '棋盘画面变了，保龄球的结果核不了',
  'shovel result could not be verified after the board changed': '棋盘变了，铲除结果核不了',
  'shovel selection could not be verified after the board changed': '棋盘变了，核不出铲子有没有拿起来',
  'collectible state could not be verified after input': '点完之后核不出目标的状态',
  'collectible disappeared without an observed collection state': '这个目标消失了，但没看到它被收取',
  'collectible input was cancelled before collection was observed': '收取在看到结果之前被取消',
  'terminal board transition was not attributed to the collection run': '棋盘的终局跳转算不到这次收取头上',
  'whack batch input release was not confirmed': '这批锤击的松开没有得到确认',
  'whack batch was cancelled during execution': '这批锤击在执行途中被取消',
  'Zen care effect was not causally verified before timeout': '时限内核不出这次照料的因果效果',
  'fertilizer purchase state could not be verified': '核不出肥料购买之后的状态',
};

export const PVZ_NATIVE_REASONS: Readonly<Record<string, PvzNativeReason>> = Object.freeze({
  ...Object.fromEntries(Object.entries(FAILED)
    .map(([reason, text]) => [reason, { text, certainty: 'failed' as const }])),
  ...Object.fromEntries(Object.entries(UNVERIFIABLE)
    .map(([reason, text]) => [reason, { text, certainty: 'unknown' as const }])),
});

export function pvzNativeReason(reason: string): PvzNativeReason | null {
  return PVZ_NATIVE_REASONS[reason] ?? null;
}
