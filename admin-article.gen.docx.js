/**
 * 管理员登录与文章添加功能 — 项目需求文档（PRD）生成脚本
 * 运行：node admin-article.gen.docx.js
 * 输出：管理员登录与文章添加功能需求文档.docx
 */
const {
  T, TB, TG, tagRun, P, PB, PH1, PH2, PH3, Pbullet, Pnum, pageBreak,
  dataCell, dataRow, altFill, cellParas, hdrCell,
  reqTable, precondTable, boundaryTable, acTable, changeTable,
  problemTable, metricTable, roleTable, permMatrix,
  callout, divider, createDoc, saveDoc, C,
} = require('./docx-skill');

// ═══════════════════════════════════════════════════════════════════════════════
// 自定义表：文章字段规格（字段 | 必填 | 校验规则 | 最大长度）
// ═══════════════════════════════════════════════════════════════════════════════
const fieldSpecTable = (rows) => ({
  width: { size: 9360, type: 3 }, // DXA
  columnWidths: [1100, 900, 5260, 2100],
  rows: [
    new (require('docx').TableRow)({ children: [
      hdrCell('字段', 1100), hdrCell('必填', 900), hdrCell('校验规则（格式）', 5260), hdrCell('最大长度', 2100)
    ]}),
    ...rows.map((r, i) => new (require('docx').TableRow)({ children: [
      dataCell(r.field, 1100, altFill(i)),
      dataCell(r.required, 900, altFill(i)),
      dataCell(r.rule, 5260, altFill(i)),
      dataCell(r.max, 2100, altFill(i)),
    ]}))
  ]
});

// 风险表：风险项 | 描述与应对 | 影响
const riskTable = (rows) => ({
  width: { size: 9360, type: 3 },
  columnWidths: [1600, 5560, 2200],
  rows: [
    new (require('docx').TableRow)({ children: [
      hdrCell('风险项', 1600), hdrCell('描述与应对', 5560), hdrCell('影响等级', 2200)
    ]}),
    ...rows.map((r, i) => new (require('docx').TableRow)({ children: [
      dataCell(r.risk, 1600, altFill(i)),
      dataCell(r.desc, 5560, altFill(i)),
      dataCell(r.level, 2200, altFill(i)),
    ]}))
  ]
});

// 注意：docx 的 Table 需要从 require('docx') 导入，直接返回对象即可被 Document 接受。
const docx = require('docx');
const Table = docx.Table;

const children = [
  // ═══════════════════════════════════════════════════════════════════════
  PH1('变更日志'),
  changeTable([
    { ver: 'v1.1', date: '2026-04-20', author: '产品 / 研发', desc: '新增「删除文章」功能需求（5.4）：文章列表、删除二次确认、删除身份校验与边界条件；权限矩阵、验收标准、迭代计划同步更新。' },
    { ver: 'v1.0', date: '2026-04-20', author: '产品 / 研发', desc: '初版发布：定义管理员登录、管理员权限管理、文章添加三大功能的需求范围、字段规则、边界条件与验收标准。' },
  ]),
  pageBreak(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('1 文档说明'),
  PH2('1.1 文档目的'),
  P('本文档定义个人主页网站后台「管理员登录」「管理员权限管理」「文章添加与删除」功能的需求范围、功能规则、边界条件与验收标准，作为设计、开发、测试与验收的依据。'),
  PH2('1.2 适用范围与读者'),
  Pbullet('适用范围：个人主页网站后台管理系统（仅管理员使用，无普通用户体系）。'),
  Pbullet('读者：产品经理、前端/后端开发工程师、测试工程师。'),
  PH2('1.3 术语与约定'),
  Pbullet('管理员：网站所有者，系统的唯一后台使用者。'),
  Pbullet('会话（Session）：登录成功后由服务端创建并维护的登录状态，用于后续权限验证。'),
  Pbullet('bcrypt：单向密码哈希算法，用于密码加密存储。'),
  Pbullet('优先级：P0 必须实现 / P1 建议实现 / P2 后续迭代。'),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('2 背景与目标'),
  PH2('2.1 项目背景'),
  problemTable([
    { id: 'P1', problem: '内容无法在线管理', current: '文章维护依赖直接编辑 HTML/JS 文件，效率低且易出错', expect: '管理员通过后台表单在线发布文章，内容自动入库' },
    { id: 'P2', problem: '后台无身份认证', current: '管理入口无登录机制，任何人可访问', expect: '仅凭管理员账户密码可登录后台' },
    { id: 'P3', problem: '无权限控制', current: '添加文章页面与提交接口未做身份校验', expect: '仅管理员可访问添加页面，每次提交前校验身份' },
    { id: 'P4', problem: '安全隐患', current: '密码无加密存储、传输未强制 HTTPS', expect: '密码 bcrypt 加密存储，全站 HTTPS 传输' },
    { id: 'P5', problem: '内容无法下线', current: '已发布文章无法在后台删除，过期内容只能改代码处理', expect: '管理员可在后台删除文章，删除后前台立即下架' },
  ]),
  PH2('2.2 目标与指标'),
  metricTable([
    { id: 'M1', metric: '正确凭据登录成功率', baseline: '无', target: '100%（一次成功）', method: '登录用例通过率' },
    { id: 'M2', metric: '未授权访问拦截率', baseline: '0%', target: '100%', method: '未登录访问后台页面/接口全部被拦截' },
    { id: 'M3', metric: '文章入库成功率', baseline: '无', target: '100%', method: '校验通过的文章全部成功写入数据库' },
    { id: 'M4', metric: '密码加密覆盖率', baseline: '0%', target: '100%', method: '数据库抽查，无明文密码' },
    { id: 'M5', metric: '非法输入拦截率', baseline: '无', target: '100%', method: '前端+后端双层校验，非法输入全部被拦截' },
  ]),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('3 用户与角色'),
  PH2('3.1 角色定义'),
  roleTable([
    { role: '管理员', desc: '网站所有者，后台唯一使用者', pain: '无法在线发布内容、担忧数据与账号安全', scene: '登录后台、发布文章、管理内容', tech: '基础操作能力', perm: '后台全部功能' },
    { role: '访客（匿名）', desc: '前台浏览用户，非系统注册用户', pain: '无', scene: '浏览网站前台文章', tech: '无', perm: '仅前台阅读，无任何后台权限' },
  ]),
  PH2('3.2 权限矩阵'),
  permMatrix(['管理员', '访客（匿名）'], [
    { action: '登录后台', perms: ['✓', '✗'] },
    { action: '访问文章添加页面', perms: ['✓', '✗'] },
    { action: '提交/发布文章', perms: ['✓', '✗'] },
    { action: '删除文章', perms: ['✓', '✗'] },
    { action: '浏览前台文章', perms: ['✓', '✓'] },
  ]),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('4 全局前置条件'),
  precondTable([
    { type: '环境', item: 'HTTPS', desc: '生产环境强制 HTTPS（HSTS），杜绝明文传输' },
    { type: '环境', item: '数据库', desc: '管理员账户表与文章表已初始化，含默认管理员账户' },
    { type: '环境', item: '依赖', desc: '服务端支持 Session 与会话管理，具备 bcrypt 密码哈希能力（如 Node.js + express-session + bcryptjs）' },
    { type: '账号', item: '管理员账户', desc: '数据库中管理员密码以 bcrypt 哈希存储，不使用明文' },
    { type: '安全', item: '参数化查询', desc: '所有 SQL 均使用参数化查询，防止 SQL 注入' },
  ]),
  pageBreak(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('5 功能需求详述'),

  // ── 5.1 管理员登录 ────────────────────────────────────────────────────
  PH2('5.1 管理员登录（LOGIN）'),
  PH3('5.1.1 前置条件'),
  Pbullet('系统已部署 HTTPS；管理员账户已在数据库中创建（密码为 bcrypt 哈希）。'),
  PH3('5.1.2 功能需求'),
  reqTable([
    { id: 'REQ-01', pri: 'P0', name: '登录页面', desc: '提供「用户名」「密码」输入框与登录按钮；支持回车提交；输入框带输入提示（placeholder）。' },
    { id: 'REQ-02', pri: 'P0', name: '防空白提交', desc: '前端校验：用户名、密码 trim 去空白后非空才允许提交；后端同样校验，任一为空返回错误提示「请输入用户名和密码」。' },
    { id: 'REQ-03', pri: 'P0', name: '登录验证', desc: '校验用户名与密码是否与数据库管理员账户一致；密码比对使用 bcrypt；用户名不存在与密码错误返回统一提示「用户名或密码错误」，防止账号枚举。' },
    { id: 'REQ-04', pri: 'P0', name: '会话管理', desc: '登录成功后创建服务端 Session，记录会话变量（管理员 ID、登录时间、过期时间），默认有效期 30 分钟并滑动续期；用于后续权限验证。' },
    { id: 'REQ-05', pri: 'P0', name: '退出登录', desc: '后台提供退出入口，退出时销毁会话并跳转登录页。' },
    { id: 'REQ-06', pri: 'P0', name: '传输安全', desc: '全站 HTTPS；登录凭据仅通过 POST 请求体传输，禁止在 URL 中携带用户名/密码。' },
    { id: 'REQ-07', pri: 'P0', name: '密码加密存储', desc: '管理员密码以 bcrypt（cost ≥ 10）哈希存储，禁止明文或可逆加密存储。' },
    { id: 'REQ-08', pri: 'P1', name: '防暴力破解', desc: '同一账户连续 5 次登录失败后锁定 15 分钟，并记录失败日志；锁定期间拒绝登录。' },
  ]),
  PH3('5.1.3 边界条件'),
  boundaryTable([
    { id: 'BC-01', scene: '空白提交', trigger: '用户名或密码为空 / 全为空白字符', behavior: '前端阻止提交并提示；后端再次校验返回 400', recover: '补全后重试' },
    { id: 'BC-02', scene: '用户名不存在', trigger: '提交未注册用户名', behavior: '统一提示「用户名或密码错误」，不区分原因', recover: '核对凭据后重试，失败计数+1' },
    { id: 'BC-03', scene: '密码错误', trigger: '密码与 bcrypt 哈希不匹配', behavior: '统一提示「用户名或密码错误」', recover: '核对凭据后重试，失败计数+1' },
    { id: 'BC-04', scene: '账户被锁定', trigger: '连续 5 次失败触发锁定', behavior: '提示「账户已锁定，请 15 分钟后再试」', recover: '锁定到期自动解锁' },
    { id: 'BC-05', scene: '会话过期/无效', trigger: 'Session 过期或被销毁', behavior: '后台操作被拒并跳转登录页', recover: '重新登录' },
    { id: 'BC-06', scene: '传输降级', trigger: '请求通过 HTTP 发起', behavior: '强制跳转 HTTPS（HSTS）', recover: '自动重定向，无需用户操作' },
    { id: 'BC-07', scene: '数据库不可用', trigger: '管理员表查询失败', behavior: '提示「系统繁忙，请稍后重试」，不泄露内部错误', recover: '服务恢复后重试' },
  ]),

  // ── 5.2 管理员权限管理 ────────────────────────────────────────────────
  PH2('5.2 管理员权限管理（AUTH）'),
  PH3('5.2.1 功能需求'),
  reqTable([
    { id: 'REQ-09', pri: 'P0', name: '页面访问控制', desc: '仅管理员可访问「添加文章」页面；未登录访问时重定向到登录页，登录成功后回跳原页面；无权限请求返回 403。' },
    { id: 'REQ-10', pri: 'P0', name: '提交身份校验', desc: '每次提交文章前，服务端必须校验 Session 中管理员身份是否有效；无效则拒绝（401/403）并引导重新登录，确保只有管理员可以提交。' },
    { id: 'REQ-11', pri: 'P1', name: '会话时效校验', desc: '每次提交请求校验会话是否过期，过期则强制重新登录后再次提交。' },
    { id: 'REQ-12', pri: 'P1', name: '接口级防护', desc: '后台写接口（提交文章）校验 CSRF Token，防止跨站请求伪造。' },
  ]),
  PH3('5.2.2 边界条件'),
  boundaryTable([
    { id: 'BC-08', scene: '未登录直接访问添加页', trigger: '访问 /admin/article/add', behavior: '重定向登录页；登录后回跳原页面', recover: '完成登录' },
    { id: 'BC-09', scene: '会话过期后提交', trigger: '停留超 30 分钟后提交', behavior: '拒绝提交并提示重新登录；前端保留已填内容不丢失', recover: '重新登录后继续编辑' },
    { id: 'BC-10', scene: '非管理员请求后台接口', trigger: '无有效会话调用提交接口', behavior: '返回 403，记录访问日志', recover: '无（需先登录）' },
    { id: 'BC-11', scene: 'CSRF Token 缺失/无效', trigger: '提交请求未携带或携带错误 Token', behavior: '拒绝请求（403）', recover: '刷新页面重新获取 Token' },
  ]),

  // ── 5.3 文章添加 ──────────────────────────────────────────────────────
  PH2('5.3 文章添加（ARTICLE）'),
  PH3('5.3.1 功能需求'),
  reqTable([
    { id: 'REQ-13', pri: 'P0', name: '文章表单', desc: '提供「标题」「内容」「类别」「标签」字段与提交按钮；标题、内容、类别必填，标签选填。' },
    { id: 'REQ-14', pri: 'P0', name: '防空白提交', desc: '前端 + 后端双重校验：所有字段 trim 后按必填规则校验，空值/全空白不允许提交并给出明确提示。' },
    { id: 'REQ-15', pri: 'P0', name: '字段校验', desc: '按 5.3.2 字段规格执行格式校验与最大长度限制，超限或格式非法时拒绝提交并提示。' },
    { id: 'REQ-16', pri: 'P0', name: '提交处理', desc: '提交前再次校验管理员身份（REQ-10）；校验通过后写入文章表；成功后提示「发布成功」并跳转/清空。' },
    { id: 'REQ-17', pri: 'P0', name: '内容安全', desc: '文章内容经 XSS 白名单过滤（去除 script、事件属性等）后存储；前台渲染时进行转义。' },
    { id: 'REQ-18', pri: 'P1', name: '防重复提交', desc: '提交期间按钮禁用防连点；服务端对同一会话短时间内的相同内容去重（5 秒内拒绝第二次）。' },
  ]),
  PH3('5.3.2 字段规格'),
  new Table(fieldSpecTable([
    { field: '标题', required: '是', rule: 'trim 后非空；去除首尾空白；禁止全空白/纯符号', max: '≤ 100 字符' },
    { field: '内容', required: '是', rule: 'trim 后非空；富文本按白名单过滤（去除 script、事件属性、iframe 等）；仅含空白或空标签视为空', max: '≤ 50,000 字符' },
    { field: '类别', required: '是', rule: '必须为系统预置类别之一（下拉选择，禁止自由输入）', max: '≤ 20 字符' },
    { field: '标签', required: '否', rule: '逗号分隔；逐项去空白、去重；仅允许中文/英文/数字/下划线/连字符', max: '每项 ≤ 20 字符，最多 5 项' },
  ])),
  PH3('5.3.3 边界条件'),
  boundaryTable([
    { id: 'BC-12', scene: '标题为空/全空白', trigger: '标题未填或仅空白字符', behavior: '拒绝提交，提示「标题不能为空」', recover: '填写标题后重试' },
    { id: 'BC-13', scene: '标题超长', trigger: '标题超过 100 字符', behavior: '拒绝提交并提示超长；输入框限制最大长度', recover: '精简标题后重试' },
    { id: 'BC-14', scene: '内容为空', trigger: '内容为空、仅空白或仅空标签', behavior: '拒绝提交，提示「内容不能为空」', recover: '填写内容后重试' },
    { id: 'BC-15', scene: '内容超长', trigger: '内容超过 50,000 字符', behavior: '拒绝提交并提示内容过长', recover: '精简内容后重试' },
    { id: 'BC-16', scene: '类别非法', trigger: '提交非预置类别', behavior: '拒绝提交，提示选择有效类别', recover: '重新选择类别' },
    { id: 'BC-17', scene: '标签违规', trigger: '标签超过 5 项或单项超 20 字符/含非法字符', behavior: '拒绝提交并提示标签规则', recover: '修正标签后重试' },
    { id: 'BC-18', scene: 'XSS 载荷', trigger: '内容含 script 等危险代码', behavior: '白名单过滤后入库；过滤后为空则拒绝', recover: '无（自动处理）' },
    { id: 'BC-19', scene: '快速重复提交', trigger: '双击提交按钮或重复请求', behavior: '第二次请求被拦截，仅入库一次', recover: '无（自动处理）' },
    { id: 'BC-20', scene: '数据库写入失败', trigger: '文章表写入异常', behavior: '提示「发布失败，请稍后重试」，保留表单内容', recover: '服务恢复后重试' },
  ]),

  // ── 5.4 删除文章 ──────────────────────────────────────────────────────
  PH2('5.4 删除文章（ARTICLE-DELETE）'),
  PH3('5.4.1 功能需求'),
  reqTable([
    { id: 'REQ-19', pri: 'P0', name: '文章列表', desc: '后台提供文章列表页，展示标题、类别、发布时间等字段，作为删除操作入口；列表支持按标题/类别检索。' },
    { id: 'REQ-20', pri: 'P0', name: '删除二次确认', desc: '每条文章提供「删除」操作；点击后弹出确认对话框并展示文章标题，二次确认后才执行删除，防止误删。' },
    { id: 'REQ-21', pri: 'P0', name: '删除身份校验', desc: '执行删除前，服务端必须校验 Session 中管理员身份是否有效（复用 REQ-10 校验逻辑）；无效则拒绝（401/403）并引导重新登录，确保只有管理员可以删除。' },
    { id: 'REQ-22', pri: 'P0', name: '删除处理', desc: '校验通过后删除数据库中对应文章记录；成功后提示「删除成功」，前台该文章立即下架，不再展示。' },
    { id: 'REQ-23', pri: 'P1', name: '批量删除', desc: '支持在列表页多选文章后批量删除；批量删除同样需二次确认与逐条权限校验。' },
    { id: 'REQ-24', pri: 'P1', name: '接口级防护', desc: '删除接口为写接口，校验 CSRF Token（复用 REQ-12 机制），防止跨站伪造删除请求。' },
  ]),
  PH3('5.4.2 边界条件'),
  boundaryTable([
    { id: 'BC-21', scene: '未登录访问列表/删除接口', trigger: '未登录访问文章列表页或调用删除接口', behavior: '重定向登录页；接口返回 401/403 并记录日志', recover: '完成登录后重试' },
    { id: 'BC-22', scene: '会话过期后删除', trigger: '停留超 30 分钟后执行删除', behavior: '拒绝删除并提示重新登录', recover: '重新登录后再次删除' },
    { id: 'BC-23', scene: '文章不存在', trigger: '删除已被删除或 ID 非法的文章', behavior: '提示「文章不存在或已被删除」，不中断流程', recover: '刷新列表' },
    { id: 'BC-24', scene: '确认框取消', trigger: '点击删除后选择「取消」', behavior: '不执行任何删除操作，停留在当前页面', recover: '无' },
    { id: 'BC-25', scene: '快速重复删除', trigger: '重复点击删除/确认或重复请求', behavior: '第二次请求被拦截，仅删除一次', recover: '无（自动处理）' },
    { id: 'BC-26', scene: '数据库删除失败', trigger: '文章表删除异常', behavior: '提示「删除失败，请稍后重试」，数据保持不变', recover: '服务恢复后重试' },
  ]),
  pageBreak(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('6 非功能需求'),
  PH2('6.1 性能'),
  Pbullet('登录接口响应 P95 ≤ 500ms（含 bcrypt 校验）。'),
  Pbullet('文章提交接口响应 P95 ≤ 1s（含内容过滤与入库）。'),
  Pbullet('bcrypt 单次校验耗时 ≤ 300ms（cost = 10）。'),
  PH2('6.2 安全'),
  Pbullet('全站 HTTPS；密码 bcrypt 加密存储；登录失败限流与账户锁定。'),
  Pbullet('SQL 参数化查询防注入；内容 XSS 过滤；后台写接口 CSRF Token 防护。'),
  Pbullet('Session ID 使用 HttpOnly Cookie；会话默认 30 分钟过期。'),
  PH2('6.3 兼容性'),
  Pbullet('支持最新版 Chrome / Edge / Firefox / Safari。'),
  Pbullet('后台页面自适应桌面端与移动端。'),
  PH2('6.4 可维护性'),
  Pbullet('后台代码与前台展示分离；字段校验规则集中配置，便于调整长度与格式限制。'),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('7 验收标准（DoD）'),
  acTable([
    { id: 'AC-01', item: '登录页防空白提交', expected: '用户名或密码为空/全空白时，前端拦截且后端返回 400', method: '手工 + 接口测试', pri: 'P0' },
    { id: 'AC-02', item: '正确凭据登录', expected: '正确用户名+密码登录成功，跳转后台并建立会话', method: '手工测试', pri: 'P0' },
    { id: 'AC-03', item: '错误凭据提示', expected: '密码错误/用户不存在均返回统一提示，不泄露账号存在性', method: '手工测试', pri: 'P0' },
    { id: 'AC-04', item: '未授权访问拦截', expected: '未登录访问添加文章页重定向登录；调用提交接口返回 401/403', method: '手工 + 接口测试', pri: 'P0' },
    { id: 'AC-05', item: '会话过期拦截', expected: '会话过期后提交被拒绝并提示重新登录，已填内容不丢失', method: '手工测试', pri: 'P0' },
    { id: 'AC-06', item: '文章入库', expected: '合法文章提交后写入数据库，页面提示发布成功', method: '手工 + 数据核对', pri: 'P0' },
    { id: 'AC-07', item: '密码加密存储', expected: '数据库中管理员密码全部为 bcrypt 哈希，抽查无明文', method: '数据库抽查', pri: 'P0' },
    { id: 'AC-08', item: '字段校验拦截', expected: '超长标题、非法类别、超量标签等均被拒绝并给出明确提示', method: '边界用例测试', pri: 'P1' },
    { id: 'AC-09', item: '暴力破解防护', expected: '连续 5 次失败后账户锁定 15 分钟', method: '自动化/手工测试', pri: 'P1' },
    { id: 'AC-10', item: '重复提交防护', expected: '快速双击仅成功发布一次', method: '手工测试', pri: 'P1' },
    { id: 'AC-11', item: '删除权限校验', expected: '未登录调用删除接口返回 401/403，无有效会话无法删除任何文章', method: '手工 + 接口测试', pri: 'P0' },
    { id: 'AC-12', item: '删除二次确认', expected: '点击删除弹出确认框并展示文章标题；选择取消不删除', method: '手工测试', pri: 'P0' },
    { id: 'AC-13', item: '删除生效', expected: '确认删除后文章从数据库移除，前台不再展示', method: '手工 + 数据核对', pri: 'P0' },
    { id: 'AC-14', item: '文章不存在处理', expected: '删除不存在的文章给出「文章不存在或已被删除」提示且不报错', method: '边界用例测试', pri: 'P1' },
  ]),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('8 迭代计划'),
  PH2('阶段一（P0 核心）'),
  Pbullet('登录页面与防空白提交、bcrypt 密码校验、会话管理（REQ-01 ~ 07）。'),
  Pbullet('页面访问控制与提交身份校验（REQ-09 ~ 11）。'),
  Pbullet('文章表单、字段校验、提交入库、XSS 过滤（REQ-13 ~ 17）。'),
  PH2('阶段二（P1 加固）'),
  Pbullet('登录失败锁定、CSRF Token、防重复提交、操作日志（REQ-08 / 12 / 18）。'),
  PH2('阶段三（文章管理完善）'),
  Pbullet('文章列表与删除文章（含二次确认、批量删除）（REQ-19 ~ 24）。'),
  PH2('阶段四（P2 扩展）'),
  Pbullet('文章编辑、草稿保存、富文本编辑器升级。'),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('9 风险评估'),
  new Table(riskTable([
    { risk: '会话安全', desc: 'Session ID 泄露/固定可导致会话劫持；应对：随机 Session ID、HttpOnly Cookie、登录成功轮换 Session ID', level: '低' },
    { risk: '暴力破解', desc: '密码被批量尝试；应对：失败计数 + 账户锁定 + 登录日志', level: '低' },
    { risk: 'XSS 注入', desc: '文章内容携带恶意脚本影响前台访客；应对：白名单过滤 + 渲染转义，作为 P0 交付', level: '中' },
    { risk: '数据丢失', desc: '入库失败或误操作导致文章丢失；应对：写入前校验、数据库定期备份', level: '低' },
    { risk: '扩展性', desc: '单管理员模型后续需扩展多角色；应对：管理员表预留角色字段，权限判断集中管理', level: '低' },
  ])),
  divider(),

  // ═══════════════════════════════════════════════════════════════════════
  PH1('10 附录'),
  PH2('10.1 术语表'),
  Pbullet('管理员：网站后台的唯一授权使用者。'),
  Pbullet('会话（Session）：服务端维护的登录状态，用于权限验证。'),
  Pbullet('bcrypt：单向密码哈希算法，不可逆，用于密码安全存储。'),
  Pbullet('CSRF：跨站请求伪造，通过 Token 校验防护。'),
  Pbullet('XSS：跨站脚本攻击，通过输入过滤与输出转义防护。'),
  PH2('10.2 参考资料'),
  Pbullet('业务方提供的需求要点《管理员登录与文章添加功能实现》（2026-04-20）。'),
  PH2('10.3 待决事项'),
  Pnum('内容字段是否支持富文本编辑器及其类型（纯文本 / Markdown / 富文本）。'),
  Pnum('「标签」是否必须填写（当前按选填处理）。'),
  Pnum('登录失败锁定阈值与锁定时长（当前 5 次 / 15 分钟）的最终确认。'),
  Pnum('删除采用物理删除还是逻辑删除（软删除 + 回收站恢复）。'),
  Pnum('是否启用草稿功能与文章编辑功能（纳入后续迭代）。'),
];

const doc = createDoc({
  title: '项目需求文档',
  subtitle: '管理员登录与文章添加功能',
  meta: ['版本 v1.0 ｜ 文档日期 2026-04-20 ｜ 项目：个人主页网站后台'],
  headerText: '个人主页后台 ｜ 项目需求文档',
  footerText: '第 ',
  children,
});

saveDoc(doc, './管理员登录与文章添加功能需求文档.docx');
