/**
 * 文案唯一来源（domain，纯常量 + 纯函数）。
 * 依据 PRD §6.1/§6.2、README 9.2 参数表最终口径、GAP-01…GAP-06。
 * 规则：页面不得各写一套；`tests/domain-copy.spec.ts` 断言关键句逐字存在。
 */
export const COPY = {
  /** 6.2-1 */
  linkNeedsPermission: '拿到链接的人仍需登录并有该项目数据权限。',
  /** 6.2-2 / GAP-03 */
  previewRetention: '预览长期保留：正式发布不会删除预览，分支删除只休眠不删除。',
  /** 6.2-3 */
  rollbackNoDb: '回滚不会回滚数据库；数据库恢复是另一个操作。',
  /** 6.2-4 */
  mainHeadOnly: '只发布 main 最新提交，显示实际构建的 SHA；无历史提交发布入口。',
  /** 6.2-5 / GAP-01 */
  specSysadminOnly: '项目资源规格与资源上限仅系统管理员可调整。',
  /** 6.2-6 / GAP-04 */
  adminParamException: '管理员可调系统并发构建数与排队上限，这是仅有的两项系统参数例外。',
  /** 6.2-7 / GAP-05 */
  cleanupScope: '本操作仅用于三种异常情形；正常预览不在可选范围，也不会被本功能删除。',
  /** 6.2-8 / GAP-06（每日备份） */
  dailyBackupRetry: '每日全量备份：任务内自动重试 3 次，仍失败才计 1 次失败并暂停新发布。',
  /** 6.2-9 / GAP-06（异地同步，不得合并） */
  offsiteSyncOnce: '异地同步：失败 1 次即暂停新发布。',
  /** 6.2-10 */
  filesReadOnly: '文件页只读：不提供在线删除、改写；不能跨项目或跨环境浏览。',
  /** 6.2-11 */
  noS3Api: '平台不提供 S3 / 对象存储 API。',
  /** 6.2-12 */
  updateSpecHardRules: '更新规范只保留你的自定义改动；与平台硬约束（权限、凭据、发布确认、存储与健康检查）冲突时会要求对齐，不能覆盖硬规则。',
  /** GAP-03 保留状态卡 */
  previewNotTouchedByPublish: '未改动任何预览（应用、库、桶、持久卷）',
  previewBackupRelation: '预览部署与预览保留不触发备份；预览数据纳入每日全量备份',
  /** 分享与授权分离 */
  shareNotGrant: '分享只生成链接：对方仍需登录，并且必须有该项目的数据权限；没有权限的人打开会是 403。',
  shareRevokeScope: '撤销后该链接 ≤30 秒失效；只影响这一条链接，不授予也不回收任何项目授权。',
  /** 授权只有一档 */
  singleGrantLevel: '被授权人看到项目后，能做什么由本人四级操作权限决定，授权本身不提升任何操作能力。',
  /** 发布边界 */
  noAutoDeploy: 'push main 与打 tag 不会自动发布，必须在本页点按钮。',
  deployConcurrency: '同一环境同时只能有 1 个发布；队列上限 10；单次超时 30 分钟，超时按失败处理且不自动重试。',
  deployShaRace: '构建期间 main 有新提交：本次按实际构建的 SHA 记录，不会自动重发。',
  rollbackScope: '可回滚范围以底座实际保留为准，不承诺任意历史版本、不承诺固定 7 天窗口。',
  /** 暂停 */
  gatePaused: '已暂停新发布',
  gateImpact: '仅阻止新发布，已运行环境继续服务。',
  gateNext: '需系统管理员按流程处理并解除暂停（解除机制原文未定 T-08，不提供自动恢复开关）。',
  /** 预览计数 */
  previewCountRule: '按未删除记录计数；停止或休眠不释放名额，只有删除才释放。',
  /** 文件/存储 */
  filesBucketScope: '只能浏览当前项目当前环境的存储桶，不能跨项目、跨环境。',
  filesLocalNotPersisted: '写进容器本地的文件不保证跨部署保留，请写存储桶或申请持久卷。',
  /** 日志 */
  aiHintDisclaimer: 'AI 建议，以原始日志为准。',
  aiSendConfirm: '只发送脱敏后的错误片段到公司内部模型网关，每次外发记审计。',
  /** 凭据 */
  mcpKeyOnce: '明文只显示这一次；之后只显示指纹前缀；不要提交到仓库。',
  /** Mock 声明（两种试跑形态必须分清：进程内 Mock / 试跑 BFF） */
  mockBanner: '试跑原型 · Mock 数据 · 非正式环境',
  trialBannerBff: '试跑原型 · 试跑 BFF（内存数据）· 非正式环境',
  mockCapability: '试跑 Mock / 未接通真实环境',
  footNoticeMock: '本页面不会连真实环境',
  footNoticeBff: '本页面只连试跑 BFF（内存仓储），不连真实底座',
  /** 禁用词，测试断言页面不出现（PRD §6.1） */
} as const

/** PRD §6.1 禁止用词（同义改写也不允许出现在界面上） */
export const FORBIDDEN_TERMS = ['已缩容', '发布后清理结果', '已清理预览', '分享授权', '邀请加入', '项目管理员', '可写权限', '任意历史版本', '停止服务'] as const

/** 状态词唯一：运行中 / 已休眠 / 未创建（不写「已缩容」） */
export const DISPLAY_STATE_LABEL = {
  running: '运行中',
  sleeping: '已休眠',
  not_created: '未创建',
} as const

export type CopyKey = keyof typeof COPY
