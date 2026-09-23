/**
 * 日志的**纯逻辑**（零依赖、可单测、前端与服务端共用）
 *
 * 设计要点：
 *   - **脱敏是硬约束**：token / Authorization / 学号 / 姓名 一律不进日志（只留长度或掩码）；
 *   - 每条日志统一结构 `{t, level, cat, msg, data}`，落盘为**一行 JSON**、导出为**一行文本**；
 *   - 环形缓冲（前端保留最近 `LOG_RING_MAX` 条）。
 *
 * 为什么脱敏放在这一层：无论是文件日志还是界面日志，都必须先过这里，
 * 避免"某个调用点忘了脱敏"就漏出去（见 ERROR.md 的纪律：token 不落盘、不打印）。
 *
 * ⚠️ 2026-09-22：`knownValuePairs()` 用的 `maskId` / `maskPhone` 来自 `./diagnostics`
 * （那里是"学号/姓名/手机怎么打码"的唯一来源）。这两个模块因此**互相引用**：
 *   · `logFormat` → `diagnostics`（取掩码函数）；
 *   · `diagnostics` → `logFormat`（取 `assertNoCredentials` 用的正则思路与类型无关，仅 import 一次）。
 * ESM 下只要**不在模块顶层互相调用**就没有副作用（两边都只在函数体里用），实测 `test:mp` 全绿。
 * 为什么宁可留这个环：把掩码口径各写一份，就会出现"诊断包里是 `张*`、日志里是 `***`"的不一致，
 * 而那正是本轮被反复咬的地方（口径必须单一来源）。
 */
import { maskDigitRuns, maskId, maskName, maskPhone } from './diagnostics'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** ISO 时间戳 */
  t: string
  level: LogLevel
  /** 类别：proxy / token / real / gate / run / submit / ui …（便于过滤） */
  cat: string
  msg: string
  /** 附加字段（**必须已经脱敏**；本模块的 redact* 负责） */
  data?: Record<string, unknown>
  /**
   * 🆕 2026-09-23：**稳定事件 id**（`DiagEvent.id`，只有 `[A-Za-z0-9._:-]`）。
   * 用途：这条事件同时上报了服务端（`POST /api/local/diagnostics/event`）⇒ 导出时要把
   * 「页面内存 / localStorage 兜底 / 服务端日志」三份**按 id 去重合并**。
   * **可选**：老数据（localStorage 里存的旧日志）没有它，合并时按"时间+文本"退化成同一个键。
   */
  id?: string
}

/** 前端环形缓冲上限 */
export const LOG_RING_MAX = 500

/**
 * 「**这个对象已经脱敏过了**」的标记（非枚举 Symbol，不进 JSON、不改变 deepEqual）。
 *
 * 用途（2026-09-22 审计 B2）：`server/utils/logger.ts` 的 `redactObject()` 会把整行 data 再脱敏一遍，
 * 而它的深度是**从日志行根**起算的 ⇒ `respBody`（响应根）在它下面只剩 ~6 层，`depth≥6` 的值
 * 会被塌成 `[deep]`，与 `respBody.bytes/truncated` 声称的"完整"矛盾（"全记录"名不副实）。
 * 「全记录」在产物上打这个标记，logger 见到就**不再二次降深度**（仍然走值级替换，双保险不变）。
 */
export const REDACTED_MARK: unique symbol = Symbol.for('totoro.redacted')

/** 打标记（返回原对象；非枚举，所以 JSON.stringify 看不到、单测 deepEqual 也不受影响） */
export function markRedacted<T>(value: T): T {
  if (value && typeof value === 'object') {
    try {
      Object.defineProperty(value, REDACTED_MARK, { value: true, enumerable: false, configurable: true })
    } catch {
      // 冻结对象等极端情况：标记失败不影响脱敏本身（只是会多走一次深度限制）
    }
  }
  return value
}

/**
 * 凭证形态与掩码函数**唯一来源**在 `./credentialScan`（2026-09-22 审计 B6 收口）。
 * 落盘掩码（本文件）与导出红线（`./diagnostics`）用**同一个函数**（闸门复验教训：两侧各写一份会
 * "掩码说安全、红线却命中"⇒ 整个日志文件被剔出包）。
 * 这里**再导出**，保持既有调用方（`composables/**`、`server/**`、单测）零改动。
 */
export { hasUnmaskedCredential, maskTokenLike } from './credentialScan'
import { maskTokenLike as maskTokenLikeImpl } from './credentialScan'

/**
 * 需要整体掩码的字段名 —— **子串判定**（2026-09-22 审计 B6）。
 *
 * 老口径是"整名精确匹配"，实测漏掉 `accessToken` / `refreshToken` / `X-Auth-Token` / `tokenValue` /
 * `appToken`（以及任何带前缀的变体）。现在只要**名字里含** token/auth/secret/sessionkey/ticket/身份字段就掩。
 *
 * ⚠️ 两处**必须排除**（实测踩到，别再加回来）：
 *   · `fingerprint`：本程序自己的 `tokenFingerprint` 是"长度 + 前后各 4 位"，掩掉它等于把核对手段废掉；
 *   · `paperName` / `pointName` / `lineName` / `campusName` / `schoolName`：这是**业务名称**
 *     （任务名、线路名、校区名），不是人名 —— 用宽 `name` 判会把"研途健行""西操场"一起掩掉，
 *     「全记录」立刻失去意义（实测）。
 * 真正的人名走 `PERSON_NAME_KEY_RE`（见下）单独判。
 */
export const SENSITIVE_KEYS =
  /(?:(?:token|authorization|auth|secret|sessionkey|session_key|ticket|sncode|stunumber|studentname|stuname|realname|idcard|idnumber|phone|phonenumber|mobile|openid|unionid|cookie)(?!fingerprint)|(?<![a-z])(?:name|姓名|学生姓名))/i

/**
 * **看起来就是一个人名**的键名（审计 B5；闸门复验后**大幅收窄**）。
 *
 * ## 🔴 闸门复验实测的故障（第一版 `/^[\u4e00-\u9fa5]{2,4}$/` 太宽）
 * `{姓名,学号,名次,分数,成绩,线路,校区,任务,状态,备注,原因,时间,总数,结果,单位}` 这 15 个键
 * 全部被换成同一个占位符 `[姓名已掩码]` ⇒ **落盘只剩 1 个键**（3 条姓名键的记录也只剩 1 条），
 * 响应内容**静默丢失**、`respShape.keys` 变成一串相同的占位符。
 *
 * ## 现在的判据（三条**同时**成立才算人名键；任一条不成立就不动）
 *   ① 键本身"像人名"：2~4 个汉字（可带 `·`）；或拼音/英文人名（`zhangxiaoming` / `ZhangXiaoMing` / `TomZhang`）；
 *   ② **不在业务键白名单里**（姓名/学号/名次/分数/成绩/线路/校区/任务/状态/备注/原因/时间/总数/结果/单位…）；
 *   ③ `valueLooksLikePersonName()`：**该键的值也像人名**（2~4 汉字，或拼音形态）。
 * 第 ③ 条是关键：`{"张小明":{ok:1}}` 这种"键是姓名、值是对象"的形态**不会被**误判成业务键，
 * 但 `{"成绩":88}`（键像人名、值是数字）会被白名单挡掉；两者都不改变键的数量与唯一性。
 */
export const BUSINESS_KEY_WHITELIST = new Set([
  '姓名', '学号', '名次', '分数', '成绩', '线路', '校区', '任务', '状态', '备注', '原因', '时间', '总数', '结果', '单位',
  'name', 'names', 'title', 'type', 'status', 'code', 'msg', 'message', 'time', 'date', 'score', 'rank', 'list', 'data', 'total', 'count', 'index', 'key', 'label', 'unit', 'reason', 'remark', 'note',
])

/**
 * **常见姓氏表（正向判据，取代"堆业务词白名单"）** —— 2026-09-23 第三轮复验 N7；第四轮**定向补入**罕见姓。
 *
 * 为什么不再堆白名单：复验方自造 **14 句全部被误掩**（`用户 积* 不足`、`考生 准** 未生成`、`账户 优** 已过期` …），
 * 说明"列举业务名词"这条路**必然漏**（业务词无穷）。正确做法是**正向门槛**：候选的第一个字必须是常见姓氏。
 *
 * ## 第四轮：定向补入"常见但当时缺失"的姓氏（**不是**无脑扩全表）
 * 复验实测漏掩 5/5：`胥小明` / `芮丽` / `邝建国` / `冼志强` / `佘诗曼` ⇒ 补入 `胥芮邝冼佘`，
 * 并同量级补入一批常见姓（`缑佴迮` 这类极罕见的不加，保持表在数百字以内）。
 * ⚠️ **每加一个姓氏都可能误伤业务词**（`常/温/易/全/钱/关/解` 这类既是姓又是常用字）：
 * 所以 `NON_NAME_WORDS` 同步补了"姓氏首字 + 业务词"的巧合词（常常/温度/容易/全部/钱包/关闭/解决/关注/解绑…），
 * 回归用例**一次跑全**（14 句 + 复验 18 句 + 真姓名，见 `tests/mp/responseRecord.test.ts`）。
 * **注意**：不是"有了姓氏表就一定能认全姓名"—— 极罕见姓/少数民族姓名仍可能漏（"有没有姓名库"的问题，见文档已知边界）。
 */
const COMMON_SURNAMES = new Set(
  (
    // 主表：百家姓常用单姓 + 常见复姓（第三轮）
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬邰盖商' +
    // 常见复姓（第三轮）
    '尉迟欧阳司马诸葛上官夏侯皇甫' +
    // —— 第四轮定向补入（复验实测漏掩的 5 个在最前）——
    '胥芮邝冼佘' +
    // 同量级的常见姓（补一批，避免"下一个用户又漏"）
    '佟赫连澹台公冶宗政濮阳淳于单于太叔申屠公孙仲孙轩辕令狐钟离宇文长孙慕容鲜于闾丘司徒司空司寇仉督子车颛孙端木巫马公西漆雕乐正壤驷公良拓跋夹谷宰父谷梁汝鄢涂钦段干百里东郭南门呼延归海羊舌微生岳帅亢况后有琴梁丘左丘东门西门南宫哈谯笪年爱第五言福'
  ).match(/./g) ?? [],
)

/** 纯汉字姓名形态（2~4 字，可带间隔号） */
const HAN_NAME_RE = /^[\u4e00-\u9fa5]{2,4}$|^[\u4e00-\u9fa5]{1,2}[·•][\u4e00-\u9fa5]{1,3}$/
/**
 * 拼音人名形态（审计 N3；**只认全小写**，第三轮 N10 收窄；第四轮门槛 8→10）。
 *
 * ⚠️ 老口径含 `^(?:[A-Z][a-z]{2,15}){2,3}$`（PascalCase）⇒ `PointName` / `RunPointList` / `ErrorMsg` 等
 * 业务键全被当人名、子树整体被抹。现在 PascalCase 一律不认；纯小写分支配合"值形态"判（见 `isPersonNameEntry`）。
 *
 * ## 第四轮：门槛 **8 → 10**（择一里的方案 ①，并**同时**做了方案 ② 的英文词黑名单）
 * 复验实测：小写 8~20 键 + 3~20 位纯字母值 ⇒ **抽样 69% 误伤**（`username:"zhangsan"`、`nickname:"xiaoming"`、
 * `password:"abc"`、`students:"green"` …）。8 位门槛放进了太多英文词（`username`/`password`/`nickname`/`students`…），
 * 10 位能挡掉一大批，**同时又恰好保住复验方要求仍要掩的 `zhangxiaoming`(13)**。
 * **代价（明确写清）**：**9 位及以下**的拼音姓名（如 `zhangxiao`(9)、`lixiaohua`(9)）**不再被当人名键**；
 * 真实姓名仍有 `known` 值级替换与 `SENSITIVE_KEYS` 兜底，且 `{"张小明":…}` 汉字键不受影响。
 */
const PINYIN_NAME_RE = /^[a-z]{10,20}$/
/** 值形态：3~20 位纯字母（拼音/英文名） */
const PINYIN_VALUE_RE = /^[A-Za-z]{3,20}$/
/**
 * 第四轮方案 ②：**常见英文词黑名单**（键或值命中就不算人名）。
 * 为什么两个方案都做：光提门槛挡不住 `parameters:"analysis"` 这类（10 位键 + 10 位值），
 * 而这些词恰恰是**最常出现的业务词**，用一张小表挡住最划算。
 */
const COMMON_EN_WORDS = new Set([
  'all', 'full', 'success', 'green', 'none', 'json', 'yes', 'ok', 'true', 'false', 'null', 'undefined', 'error',
  'data', 'list', 'name', 'names', 'type', 'types', 'code', 'codes', 'status', 'state', 'value', 'values', 'key', 'keys',
  'username', 'nickname', 'password', 'students', 'metadata', 'children', 'response', 'arguments', 'parameters',
  'sections', 'keywords', 'features', 'contents', 'messages', 'settings', 'comments', 'warnings', 'degraded', 'envelope',
  'analysis', 'details', 'summary', 'results', 'records', 'options', 'request', 'requests', 'server', 'client', 'config',
  'production', 'development', 'testing', 'staging', 'default', 'example', 'sample', 'unknown', 'pending', 'loading',
  'enabled', 'disabled', 'visible', 'hidden', 'public', 'private', 'internal', 'external', 'static', 'dynamic',
])
/** PascalCase 且**尾词是业务词**的键（`PointName`/`TaskList`/`ErrorMsg`…）—— 直接豁免 */
const BUSINESS_CAMEL_TAIL_RE = /(Name|Names|List|Lists|Info|Msg|Message|Data|Datas|Code|Status|Type|Time|Date|Count|Total|Map|Set|Key|Value|Id|Ids|Url|Uri|Path|Config|Option|Options|Item|Items|Result|Results|Record|Records)$/

/** 值是否"像人名"（用于把"键像人名"收敛成"这一对真的像人名"） */
export function valueLooksLikePersonName(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || s.length > 24) return false
  return HAN_NAME_RE.test(s) || PINYIN_NAME_RE.test(s)
}

/** 键名是否像人名（**不含**值判定；调用方通常还需配 `valueLooksLikePersonName`） */
export function looksLikePersonNameKey(k: string): boolean {
  const s = String(k ?? '').trim()
  if (!s) return false
  if (BUSINESS_KEY_WHITELIST.has(s.toLowerCase()) || BUSINESS_KEY_WHITELIST.has(s)) return false
  if (BUSINESS_CAMEL_TAIL_RE.test(s)) return false
  if (HAN_NAME_RE.test(s)) return true
  return PINYIN_NAME_RE.test(s)
}

/**
 * 一对"键值"是否构成"人名键"。**两条分支的判据不同**（第三轮 N10 修正的关键）：
 *
 *   · **汉字分支**：键是 2~4 汉字（可带 `·`）—— 值可以是字符串（`{"张小明":"张小明"}`）
 *     或**对象**（`{"张小明":{...}}`，键本身就是姓名）；
 *   · **拼音分支**：键是 8~20 位全小写 —— **必须**"值是字符串、且值也像拼音人名"。
 *     ⚠️ 老口径"值是对象也算"用在拼音分支上 ⇒ `{"students":[…]}`、`{"degraded":[…]}`、`{"metadata":{…}}`
 *     这些**普通英文键 + 对象值**全被当人名 ⇒ **整棵子树被抹**（实测：6 棵子树内容整体丢失；
 *     我们自己的降级 warn `{degraded:[…]}` 被抹成 `{"degraded":"[masked len=69]"}`，维护者看不到降了哪几档）。
 */
export function isPersonNameEntry(k: string, v: unknown): boolean {
  const s = String(k ?? '').trim()
  if (!s) return false
  if (BUSINESS_KEY_WHITELIST.has(s.toLowerCase()) || BUSINESS_KEY_WHITELIST.has(s)) return false
  if (BUSINESS_CAMEL_TAIL_RE.test(s)) return false
  if (HAN_NAME_RE.test(s)) return valueLooksLikePersonName(v) || (v !== null && typeof v === 'object')
  if (PINYIN_NAME_RE.test(s)) {
    /**
     * 全小写 10~20 位：`zhangxiaoming` 要掩，而 `students` / `metadata` / `parameters` 不要。
     * 两者形态一样，靠三层区分：① 值必须是**字符串**且为 3~20 位纯字母；
     * ② 键与值都**不在** `COMMON_EN_WORDS`（常见英文词黑名单）；③ 门槛已从 8 提到 10。
     * 代价见 `PINYIN_NAME_RE` 的注释（9 位及以下的拼音姓名不再掩）。
     */
    if (typeof v !== 'string') return false
    const val = v.trim()
    if (!PINYIN_VALUE_RE.test(val)) return false
    if (COMMON_EN_WORDS.has(s.toLowerCase()) || COMMON_EN_WORDS.has(val.toLowerCase())) return false
    return true
  }
  /**
   * PascalCase / camelCase 里的**人名**（`ZhangXiaoMing` / `TomZhang`）：
   * 要求"值是非空且不含中文的短串"（`PointName:"西操场"` 这种业务名因值是中文/长串而不认）。
   */
  if (/^(?:[A-Z][a-z]{1,15}){2,3}$|^[A-Z][a-z]{1,15}(?:[A-Z][a-z]{1,15})+$/.test(s)) {
    return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 24 && !/[\u4e00-\u9fa5]/.test(v)
  }
  return false
}

/**
 * **自述人名的保守兜底**（闸门复验 B3 残漏）：GET 请求**没有请求体** ⇒ `known` 对照表是空的，
 * 于是响应自由文本里的 `张小明` 会原样落盘。姓名本身没有形态特征（无法从"张小明"三个字看出这是人名），
 * 所以只能靠**上下文模式**做保守兜底：只在人名"紧跟在一个明确的人称/姓名提示词之后"时才掩。
 *
 * 例：`未找到用户 2021101234（张小明，13812345678）` ⇒ `张小明` 前有 `（`、更前面是"用户" ⇒ 掩。
 *
 * ⚠️ 已知边界（写清楚，别以为全覆盖了）：**完全没有上下文**的裸姓名（如 `{"张小明":{…}}` 这种
 * 只在键名里出现的）靠 `isPersonNameEntry()` 那条判；而"正文里凭空出现一个姓名"无法可靠识别 ——
 * 那需要姓名库，属另一条线。这里只保证"常见错误文案里的第 3 类"不漏。
 */
const NAME_CUE = '(?:用户|学生|同学|姓名|考生|选手|运动员|账号|账户|同学叫|名叫)'
const SELF_DESCRIBED_HAN_NAME_RE = new RegExp(`(${NAME_CUE}[\\s:：=]*|[(（【\\[][\\s]*)([\\u4e00-\\u9fa5]{2,3})(?=[)）】\\]，,。;；\\s]|$)`, 'g')
/**
 * 常见非姓名词（**辅助判据**，不是主判据）。
 *
 * 🔴 第三轮复验 N7 的教训：**列举式白名单必然漏**（复验方自造 14 句全部被误掩：
 * `用户 积* 不足`、`考生 准** 未生成`、`账户 优** 已过期`、`学生 宿* 未分配` … 业务词是无穷的）。
 * 所以主判据改成**正向门槛**：候选的第一字必须是 `COMMON_SURNAMES` 里的常见姓氏（见 `maskSelfDescribedNames`）。
 * 这张表只作**补充**（挡住少数"姓氏首字 + 业务词"的巧合，如 `王 成绩`），不再是唯一防线。
 */
const NON_NAME_WORDS = new Set([
  // 动词 / 提示语 / 状态词
  '登录', '过期', '失效', '成功', '失败', '信息', '档案', '任务', '设置', '服务', '系统', '数据',
  '开始', '结束', '提交', '读取', '未找到', '错误', '异常', '提示', '结果', '状态', '不存在', '不允许', '不支持',
  // 业务名词（复验给的两条 + 常见同类）
  '余额', '名单', '成绩', '学号', '姓名', '名次', '分数', '校区', '学校', '线路', '跑道', '记录', '备注', '原因',
  '时间', '总数', '数量', '次数', '人数', '单位', '部门', '班级', '学院', '专业', '科目', '项目', '账号',
  '账户', '密码', '手机', '电话', '邮箱', '地址', '考试', '课程', '作业', '论文', '报告', '通知', '公告',
  '消息', '权限', '角色', '菜单', '页面', '接口', '设备', '版本', '更新', '日志',
  // 复验方第二轮 14 句里的那批（保留为补充防线；主防线是姓氏表）
  '积分', '准考证', '优惠', '宿舍', '订单', '座位', '头像', '昵称', '借阅', '钱包', '实名', '学历', '志愿', '发票',
  /**
   * 🆕 第四轮：**首字恰好是姓氏**的业务词（复验实测 `用户 关注 失败→关*`、`账户 解绑 需验证→解*`）。
   * 这类词没法靠"改姓氏表"解决（关注/解绑确实是常用词），只能在这里挡住；
   * 同时把"姓氏首字 + 常用字"的巧合词一并补上（常常/温度/容易/全部…），
   * 因为第四轮补姓氏时也会碰到同样的风险。
   */
  '关注', '解绑', '绑定', '报名', '请假', '缴费', '签到', '选课', '挂失', '补考', '退课', '激活', '查分', '认证', '冻结',
  '常常', '温度', '容易', '全部', '钱包', '关闭', '解决', '并且', '或许', '可能', '确保', '例如', '关于', '关键',
  '容易', '完全', '完整', '安静', '安全', '安静', '实际', '审查', '审核', '尝试', '常见', '经常', '日常', '非常',
  '计费', '计算', '订票', '讨论', '记录', '设备', '设计', '访问', '询问', '详情', '说明', '请求', '请勿', '请问',
])

/**
 * 把"紧跟人称提示词之后的 2~3 个汉字"掩成 `X**` 形态（**正向判据**：首字必须是常见姓氏）。
 *
 * 三条**同时**成立才掩：
 *   ① 候选的第一个字 ∈ `COMMON_SURNAMES`（正向门槛 —— 这是 N7 的关键修正）；
 *   ② cue 与候选之间**没有其它汉字**（正则已保证：cue 后只允许空白/冒号/括号）；
 *   ③ 候选后**紧跟非汉字边界**（标点/空格/行尾/括号，正则已保证）。
 * 外加 NON_NAME_WORDS 兜一层"姓氏首字 + 业务词"的巧合。
 *
 * 于是 `用户 余额 不足`（余**不在常见姓氏表**里 → 不掩）、`考生 名单 已过期`（名 ≠ 常见姓氏）都不再被误掩，
 * 而 `未找到用户 张小明`（张 ∈ 姓氏表）仍然照掩。
 */
export function maskSelfDescribedNames(text: string): string {
  const s = String(text ?? '')
  if (!/[\u4e00-\u9fa5]/.test(s)) return s
  return s.replace(SELF_DESCRIBED_HAN_NAME_RE, (whole, cue: string, name: string) => {
    if (NON_NAME_WORDS.has(name)) return whole
    // ① 正向门槛：首字必须是常见姓氏（复姓取前两字）
    const first = name[0]!
    const firstTwo = name.slice(0, 2)
    if (!COMMON_SURNAMES.has(first) && !COMMON_SURNAMES.has(firstTwo)) return whole
    return `${cue}${maskName(name)}`
  })
}

/**
 * 字符串的**值级脱敏总入口**（顺序：已知原值 → 自述人名兜底 → 凭证/数字掩码）。
 * 为什么把顺序写进一个函数：三处（`redactValue`、recorder 的 walk、recorder 的 maskDigits）都要跑同一套，
 * 各写一遍迟早漂移（闸门复验已经因为"两侧判据不同"出过一次事故）。
 */
export function redactFreeText(text: string, values: { raw: string; masked: string }[] = []): string {
  let s = String(text ?? '')
  for (const p of values) s = s.split(p.raw).join(p.masked)
  s = maskSelfDescribedNames(s)
  return maskDigitRuns(maskTokenLikeImpl(s))
}
/**
 * 键名脱敏：**绝不改变键的数量与唯一性**（闸门复验要求）。
 *
 * 做法：先按 `maskKey` 算出掩码后的名字；若同一层里出现**重复**（无论原本重复还是掩码后撞车），
 * 追加 `#1`/`#2` 后缀保证唯一。原来 15 个不同的中文键现在最多变成 `[姓名已掩码]`、`[姓名已掩码]#1`…
 * —— 键数不变，但内容**不再全部塌成一个键**（此前实现会静默丢 14 个键）。
 */
export function maskKeysPreservingUniqueness<K extends string>(keys: K[], maskKey: (k: K) => string): string[] {
  const seen = new Map<string, number>()
  return keys.map((k) => {
    const base = maskKey(k)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}

/** 掩码一个敏感值：只保留长度（数字/布尔等短值直接原样，避免把 `0` 也掩掉） */
export function maskSensitive(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return `[masked len=${s?.length ?? 0}]`
}

/**
 * 一个"已知原值 → 掩码形态"的对照表（**长的在前**，避免长串被短串先替换掉）。
 * 输入是任意对象（实际用**请求体**）：名字敏感、且值是字符串/数字的字段被收进对照表。
 *
 * 用途：`redactObject()` 的值级替换（同一批值可能以别的拼写出现在别处）。
 * 为什么放在本模块（而不是「全记录」模块）：`redactObject` 要用它 ⇒ 放这里**没有循环依赖**。
 */
export function knownValuePairs(input: unknown): { raw: string; masked: string }[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const pairs: { raw: string; masked: string }[] = []
  const add = (raw: unknown, masked: string) => {
    const v = String(raw ?? '').trim()
    if (v.length < 2) return // 太短的值（如 "1"）全局替换会误伤正常文本
    if (v === masked) return
    if (pairs.some((p) => p.raw === v)) return
    pairs.push({ raw: v, masked })
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!SENSITIVE_KEYS.test(key)) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const raw = String(value)
    /**
     * 掩码口径**与诊断包完全一致**（同一组函数）：学号/姓名/手机分别用
     * `maskId` / `maskName` / `maskPhone`。⚠️ 别把姓名也丢给 `maskId` ——
     * 那会让 `张小明` 变成 `**`（连姓都不剩），而界面上是 `张**`，两边对不上会让人以为漏了。
     */
    if (/^(phone|phonenumber|mobile)$/i.test(key) || /^\d{11}$/.test(raw)) add(raw, maskPhone(raw))
    else if (/^(studentname|stuname|realname|name)$/i.test(key)) add(raw, maskName(raw))
    else add(raw, maskId(raw))
  }
  return pairs.sort((a, b) => b.raw.length - a.raw.length)
}

/**
 * 递归脱敏：按字段名掩码 + 把任何形似 token 的字符串片段掩掉。
 *
 * @param values 🆕 2026-09-22「全记录」用：**已知原值 → 掩码形态**的对照表（来自请求体里的学号/姓名/手机）。
 *   为什么会走到这里（而 `redactObject` 的调用方没传）：`SENSITIVE_KEYS` 只按**字段名**掩码，
 *   而同一批值可能又以**别的拼写**出现在别处（如错误文案里的"未找到用户 2021101234"）——
 *   这一层负责把"已知的那几个原值"在**任意字符串**里就地换掉。
 */
export function redactValue(key: string, value: unknown, depth = 0, values: { raw: string; masked: string }[] = [], maxDepth = 8): unknown {
  /**
   * 🔴 **标量先掩、再看深度**（2026-09-22 闸门复验的必修）：
   * 老实现把 `if (depth > maxDepth) return '[deep]'` 放在**最前面**，于是超过 8 层的子树被**原样返回**——
   * 实测 11 层嵌套里的 `token:'WXXCX…'` 与 `studentName:'张小明'` **原文落盘**
   * （"把丢内容换成了漏原文"，比丢内容严重得多）。现在：
   *   · 字符串/数字**永远先做值级脱敏**（token 样式 + 已知原值 + 数字兜底）；
   *   · 深度只决定"**结构还展开不展开**"：超过 `maxDepth` 就整体换成 `[层级过深，值已脱敏]`
   *     （对象/数组）/ 掩码后的标量。**任何路径都不会把原值原样放行。**
   *   · 内部仍有 24 层的硬上限，防病态深嵌套把调用栈打爆（此时同样返回"已脱敏"标记，不是原值）。
   */
  if (depth > 24) return '[层级过深，值已脱敏]'
  if (SENSITIVE_KEYS.test(key) || isPersonNameEntry(key, value)) return maskSensitive(value)
  if (typeof value === 'string') {
    const masked = redactFreeText(value, values)
    return depth > maxDepth ? `[层级过深，值已脱敏] ${masked}` : masked
  }
  if (typeof value === 'number') {
    /**
     * 🔴 数字型学号/手机也要掩（审计 B4）：`{"list":[2021101234,13812345678]}` 里的值是 JSON **number**，
     * 只判 string 会原样落盘。判据与 `maskDigitRuns` 同口径：**8~18 位整数**（无小数/无科学计数）。
     */
    if (Number.isInteger(value)) {
      const s = String(value)
      if (s.length >= 8 && s.length <= 18) return /^1\d{10}$/.test(s) ? maskPhone(s) : maskId(s)
    }
    return value
  }
  if (value === null || value === undefined || typeof value !== 'object') return value
  /**
   * 🔒 已脱敏过的子树（「全记录」的 `respBody`）**原样返回**：它内部早在更靠根的深度上脱敏完了
   * （且其中的**标量已全部掩过**），再降一次深度只会把深层内容塌掉（审计 B2）。
   * ⚠️ 这个标记**不是**"免检"：recorder 的 `redactForRecord()` 对每个标量都做过同样的四步脱敏。
   */
  if ((value as Record<PropertyKey, unknown>)[REDACTED_MARK] === true) return value
  if (depth > maxDepth) return '[层级过深，值已脱敏]'
  if (Array.isArray(value)) {
    // 数组里的元素若形似 token 也要掩（例如扫描器回传的候选列表）
    return value.slice(0, 20).map((v, i) => redactValue(String(i), v, depth + 1, values, maxDepth))
  }
  const obj = value as Record<string, unknown>
  /**
   * 键名脱敏 + **键的数量与唯一性不变**（闸门复验：`/^[\u4e00-\u9fa5]{2,4}$/` 曾把 15 个中文键
   * 全塌成同一个占位符 ⇒ 落盘只剩 1 个键、内容静默丢失）。掩码后撞车的键追加 `#1`/`#2` 后缀。
   */
  const rawKeys = Object.keys(obj)
  const safeKeys = maskKeysPreservingUniqueness(rawKeys, (k) => maskDigitRuns(maskTokenLikeImpl(k)))
  const out: Record<string, unknown> = {}
  rawKeys.forEach((rawKey, i) => {
    out[safeKeys[i]!] = redactValue(rawKey, obj[rawKey], depth + 1, values, maxDepth)
  })
  return out
}

/**
 * 脱敏一个对象（用于 data 字段）。
 *
 * 🆕 2026-09-22「全记录」加固：**默认就把"同一对象里名字敏感的字段值"当作对照表**再跑一遍值级替换
 * （`redactValue` 的 `values`）。为什么需要：字段名脱敏只掩"那一处"，而同一个学号/姓名
 * 可能又以别的拼写出现在同一行的其它字符串里（错误文案、上游原话引用）——
 * 不传对照表就会漏。对**不含敏感字段**的对象，对照表为空 ⇒ 行为与旧版**逐字节一致**。
 *
 * @param values 额外补充的对照表（例如从请求体里取到的值）；默认由 `input` 自身推导。
 */
export function redactObject(
  input: Record<string, unknown> | undefined | null,
  values: { raw: string; masked: string }[] = [],
): Record<string, unknown> | undefined {
  if (!input) return undefined
  const derived = values.length ? values : knownValuePairs(input)
  return redactValue('', input, 0, derived) as Record<string, unknown>
}

/** 截断过长文本（避免一条日志几 MB） */
export function truncate(text: string, max = 2000): string {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…[截断，共 ${s.length} 字符]`
}

/**
 * 从上游响应里取状态摘要（用于代理日志）。
 *
 * 🔴 2026-09-22 审计 B3：这里的 `msg`/`message` 是**上游自由文本**（实测 `"未找到用户 2021101234 登录失败"`），
 * 老实现**原样放进日志行** ⇒ 学号/姓名/手机明文落盘（而同一行的 `respBody.msg` 却是掩过的，前后矛盾）。
 * 现在每个值都过 `redactValue`（字段名掩码 + 值级替换 + token 样式）与 `maskDigitRuns`（数字兜底）。
 */
export function summarizeUpstream(json: unknown, known: { raw: string; masked: string }[] = []): Record<string, unknown> {
  if (!json || typeof json !== 'object') return { kind: typeof json }
  const r = json as Record<string, unknown>
  const header = (r.header ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['status', 'code', 'msg', 'message', 'total']) {
    if (r[k] === undefined || r[k] === null || r[k] === '') continue
    // 自由文本字段（msg/message）必须脱敏；标量码（status/code/total）也走一遍（代价极小、不会误伤短码）
    const v = r[k]
    out[k] = typeof v === 'string' ? maskDigitRuns(String(redactValue(k, v, 0, known))) : v
  }
  if (header.bizCode !== undefined) out.bizCode = header.bizCode
  return out
}

/** 追加到环形缓冲（返回新数组；超出上限丢最旧的） */
export function pushRing<T>(arr: readonly T[], item: T, max = LOG_RING_MAX): T[] {
  const next = [...arr, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 一行文本（导出/文件用） */
export function formatEntryLine(e: LogEntry): string {
  const data = e.data && Object.keys(e.data).length ? ` ${JSON.stringify(e.data)}` : ''
  return `${e.t} [${e.level.toUpperCase().padEnd(5)}] [${e.cat}] ${e.msg}${data}`
}

/** 导出为可复制的多行文本（最新的在后；空日志给提示） */
export function entriesToText(entries: readonly LogEntry[]): string {
  if (!entries.length) return '（暂无日志）'
  return entries.map(formatEntryLine).join('\n')
}

/** 统计各等级条数（界面徽标用） */
export function countByLevel(entries: readonly LogEntry[]): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 }
  for (const e of entries) out[e.level] = (out[e.level] ?? 0) + 1
  return out
}
