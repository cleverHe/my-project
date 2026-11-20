/**
 * 错误目录（与前端 domain/errors.ts 同一套 errorCode，见 api-spec v1.0 §1.2）
 * 页面按 errorCode 展示三段式说明，不按 HTTP 状态自造文案。
 */
export interface ErrorRow {
  status: number
  what: string
  impact: string
  nextStep: string
}

export const ERROR_TABLE = {
  // ---- api-spec v1.0 §2.2 对齐码（契约脚本使用这些名字）----
  'auth.unauthenticated': {
    status: 401,
    what: '未登录或会话已过期。',
    impact: '本次操作未执行，没有修改任何数据。',
    nextStep: '重新登录后会回到原页面。',
  },
  'auth.account_disabled': {
    status: 403,
    what: '账号已停用。',
    impact: '无法进入门户，也无法调用接口。',
    nextStep: '联系管理员核对账号状态。',
  },
  'authz.permission_unavailable': {
    status: 503,
    what: '权限系统当前不可用，写操作已拒绝。',
    impact: '没有写入生效；只读仍可用。',
    nextStep: '稍后重试；持续失败请把 traceId 给系统管理员。',
  },
  'env.not_found': {
    status: 404,
    what: '环境不存在或你无权访问。',
    impact: '看不到该环境的内容。',
    nextStep: '回到项目页确认环境仍在，或联系拥有者授权。',
  },
  'deploy.already_running': {
    status: 409,
    what: '该环境已有发布或回滚在进行。',
    impact: '本次提交未进入队列，没有切换流量。',
    nextStep: '等当前任务结束再提交；重复提交不会产生第二个任务。',
  },
  'deploy.queue_full': {
    status: 429,
    what: '发布队列已满（10）。',
    impact: '本次提交未入队。',
    nextStep: '等队列消化后重试。',
  },
  'request.param_invalid': {
    status: 400,
    what: '请求参数不合法。',
    impact: '本次操作未执行。',
    nextStep: '按提示修正后重试。',
  },
  'request.param_unknown': {
    status: 400,
    what: '请求包含无法识别的参数。',
    impact: '本次操作未执行。',
    nextStep: '刷新页面后用页面提供的入口重试。',
  },
  'request.idempotency_required': {
    status: 400,
    what: '缺少幂等键（Idempotency-Key）。',
    impact: '本次发布未创建，没有重复风险。',
    nextStep: '刷新页面后重新点击发布。',
  },
  'mcp.self_approve_denied': {
    status: 403,
    what: '发布确认必须由本人操作，Agent 不能代为确认。',
    impact: '确认未生效，发布任务没有创建。',
    nextStep: '请本人在页面确认；MCP Key 只能发起请求。',
  },
  'mcp.key_invalid': {
    status: 401,
    what: 'MCP Key 无效或已撤销。',
    impact: 'Agent 调用被拒绝。',
    nextStep: '重新生成 Key；撤销 ≤1 分钟生效。',
  },
  'mcp.capability_denied': {
    status: 403,
    what: '该能力不在首期白名单内。',
    impact: 'Agent 调用被拒绝。',
    nextStep: '用页面手动操作。',
  },
  'rollback.target_missing': {
    status: 404,
    what: '该版本不在底座可回退范围内。',
    impact: '没有切换流量，当前版本继续服务。',
    nextStep: '从可回退列表里选一个版本；数据库不会被回滚。',
  },
  'rollback.reason_required': {
    status: 422,
    what: '回滚到更早版本需要填写原因。',
    impact: '本次回滚未执行。',
    nextStep: '补上回滚原因后重试。',
  },
  'file.path_invalid': {
    status: 400,
    what: '文件路径不合法（不允许 .. 或绝对路径绕过）。',
    impact: '本次读取被拒绝，没有读到任何目录。',
    nextStep: '返回上一级重新进入目录。',
  },
  'file.not_found': {
    status: 404,
    what: '文件或目录不存在。',
    impact: '没有读取到内容。',
    nextStep: '刷新目录后重试。',
  },
  'file.too_large': {
    status: 413,
    what: '文件超过单文件上限。',
    impact: '本次下载被拒绝，没有开始传输。',
    nextStep: '下载或分卷后重试；上限值待系统参数定值。',
  },
  'cleanup.scope_invalid': {
    status: 409,
    what: '所选预览不在可清理范围内。',
    impact: '一个都没有删除。',
    nextStep: '只可选停用账号遗留、删除项目残留、无法自行删除的异常预览。',
  },
  'cleanup.confirm_required': {
    status: 422,
    what: '缺少二次确认或确认文案不匹配。',
    impact: '一个都没有删除。',
    nextStep: '按所选数量填写确认文案后重试。',
  },
  'request.path_unknown': {
    status: 404,
    what: '该端点未在 api-spec v1.0 中定义。',
    impact: '本次请求未执行任何业务逻辑。',
    nextStep: '用页面提供的入口操作；若确为缺失能力，反馈给技术评审。',
  },
  'internal.unexpected': {
    status: 500,
    what: '服务出现未分类异常。',
    impact: '本次操作未完成，可能没有写入。',
    nextStep: '带 traceId 联系系统管理员。',
  },
  'auth.session_expired': {
    status: 401,
    what: '登录状态已失效。',
    impact: '本次操作未执行，没有修改任何数据。',
    nextStep: '重新登录后会回到原页面。',
  },
  'auth.forbidden': {
    status: 403,
    what: '当前账号不能进入该范围。',
    impact: '页面与接口都不可用，不是显示问题。',
    nextStep: '联系管理员核对账号状态或数据权限。',
  },
  'authz.forbidden': {
    status: 403,
    what: '你没有执行该操作的权限。',
    impact: '操作被拒绝，数据未改变。',
    nextStep: '按页面提示找拥有者、管理员或系统管理员；拿到链接也不代表有权限。',
  },
  'authz.unavailable': {
    status: 503,
    what: '权限系统当前不可用，写操作已全部拒绝。',
    impact: '没有任何写入生效（fail-closed），不存在半成功。',
    nextStep: '稍后重试；不要重复提交，持续失败请把 traceId 给系统管理员。',
  },
  'auth.csrf_invalid': {
    status: 403,
    what: '请求缺少或携带了错误的 CSRF 令牌。',
    impact: '写操作被拒绝，数据未改变。',
    nextStep: '刷新页面后重试；不要复用旧表单。',
  },
  'request.invalid': {
    status: 422,
    what: '请求参数不符合要求。',
    impact: '本次操作未执行。',
    nextStep: '按提示修正后重试。',
  },
  'request.idempotency_conflict': {
    status: 409,
    what: '同一个幂等键被用于不同的请求内容。',
    impact: '本次操作未执行。',
    nextStep: '刷新页面后重新发起；不要改写旧请求体。',
  },
  'project.not_found': {
    status: 404,
    what: '项目不存在或已被删除。',
    impact: '看不到任何项目内容。',
    nextStep: '回到 Dashboard；30 天内可让管理员恢复已删除项目。',
  },
  'project.name_conflict': {
    status: 409,
    what: '项目名已被使用。',
    impact: '没有创建任何资源。',
    nextStep: '换一个名称后重试。',
  },
  'project.template_unavailable': {
    status: 422,
    what: '模板库暂不可用，所选模板无法加载。',
    impact: '项目未创建；系统不会静默改用空仓库。',
    nextStep: '改用空白模板，或联系系统管理员修复模板库。',
  },
  'project.quota_exceeded': {
    status: 429,
    what: '磁盘水位已达阈值，无法开通新项目。',
    impact: '项目未创建；已运行项目不受影响。',
    nextStep: '联系系统管理员处理容量（规格只有系统管理员能调整）。',
  },
  'project.spec_sysadmin_only': {
    status: 403,
    what: '项目资源规格只有系统管理员可以调整。',
    impact: '规格未改变。',
    nextStep: '向系统管理员提交调整申请；管理员与普通用户都不能自行扩容。',
  },
  'deploy.backup_paused': {
    status: 423,
    what: '备份失败已暂停新发布。',
    impact: '本次发布未开始；已运行环境继续服务。',
    nextStep: '由系统管理员按流程处理并解除暂停（解除机制原文未定 T-08），恢复后重新发布。',
  },
  'deploy.busy': {
    status: 409,
    what: '该环境已有发布或回滚在进行。',
    impact: '本次请求被拒绝，没有排队也没有重复执行。',
    nextStep: '等当前任务结束；队列中的任务不会自动重试。',
  },
  'deploy.version_invalid': {
    status: 422,
    what: '版本标签格式不正确。',
    impact: '发布未开始。',
    nextStep: '使用类似 v1.2.0 的格式。',
  },
  'deploy.version_duplicate': {
    status: 409,
    what: '该版本标签已存在。',
    impact: '发布未开始。',
    nextStep: '换一个版本标签，避免无法区分的构建记录。',
  },
  'deploy.rollback_record_missing': {
    status: 409,
    what: '该发布记录不可回退（镜像已被底座回收）。',
    impact: '没有回滚，当前版本继续服务。',
    nextStep: '选择其他可回退记录，或重新发布一个新版本。',
  },
  'deploy.rollback_isolation': {
    status: 409,
    what: '回滚不能跨环境，也不能回滚数据库。',
    impact: '回滚未执行。',
    nextStep: '对目标环境单独回滚；数据库恢复需在系统设置中单独确认。',
  },
  'preview.limit_reached': {
    status: 429,
    what: '预览名额已满（上限 3，休眠不释放名额）。',
    impact: '预览未创建，系统不会自动淘汰其他预览。',
    nextStep: '先删除不需要的预览；系统不会自动淘汰其他预览，异常预览由系统管理员手工清理。',
  },
  'preview.branch_deleted': {
    status: 409,
    what: '该分支已删除。',
    impact: '预览仍在保留（不会自动删除）。',
    nextStep: '需要时手动删除该预览，或保留不动。',
  },
  'preview.wake_timeout': {
    status: 504,
    what: '唤醒超时（60 秒内未就绪）。',
    impact: '预览仍为已休眠，没有切到半可用状态。',
    nextStep: '重试一次；持续失败请把 traceId 给管理员。',
  },
  'preview.cleanup_scope_invalid': {
    status: 422,
    what: '选择的预览不在异常范围内。',
    impact: '没有删除任何预览。',
    nextStep: '只能清理三种异常情形（拥有者停用 / 项目已删除 / 无法删除的残留）。',
  },
  'preview.cleanup_confirm_required': {
    status: 422,
    what: '缺少第二次确认或确认词不正确。',
    impact: '没有删除任何预览。',
    nextStep: '重新走两步确认，并填写清理原因（会写入每条审计）。',
  },
  'admin.param_forbidden': {
    status: 403,
    what: '该参数不在管理员可调范围。',
    impact: '参数未改变。',
    nextStep: '管理员只能调构建并发与队列上限；其余参数由系统管理员维护。',
  },
  'admin.param_raise_forbidden': {
    status: 422,
    what: '压测结论内只可下调，不可上调。',
    impact: '参数未改变。',
    nextStep: '只能填写不超过当前值的数字。',
  },
  'admin.param_out_of_range': {
    status: 422,
    what: '参数超出允许范围。',
    impact: '参数未改变。',
    nextStep: '填写范围内的整数。',
  },
  'audit.write_failed': {
    status: 500,
    what: '审计写入失败，因此本次操作按失败处理。',
    impact: '业务动作没有生效（不做无审计的写操作）。',
    nextStep: '稍后重试；持续失败请把 traceId 给系统管理员。',
  },
  'backup.restore_confirm_required': {
    status: 422,
    what: '恢复需要输入确认词 RESTORE。',
    impact: '恢复未开始。',
    nextStep: '按页面提示输入确认词后重试。',
  },
  'platform.unavailable': {
    status: 502,
    what: '底座（Dokploy）当前不可用。',
    impact: '本次操作未执行；已运行环境不受门户影响。',
    nextStep: '稍后重试；持续失败请把 traceId 给运维。',
  },
  'request.unknown': {
    status: 500,
    what: '请求未被服务端正常处理。',
    impact: '本次操作未生效。',
    nextStep: '重试一次；仍失败请把 traceId 给管理员。',
  },
} as const satisfies Record<string, ErrorRow>

export type ErrorCode = keyof typeof ERROR_TABLE

export interface ApiErrorBody {
  errorCode: ErrorCode | string
  message: string
  nextStep: string
  traceId: string
  details?: Record<string, unknown>
  /** 服务端补充的三段式说明，前端可直接展示 */
  what?: string
  impact?: string
}

export function errorBody(code: ErrorCode, traceId: string, details?: Record<string, unknown>): ApiErrorBody {
  const row = ERROR_TABLE[code]
  return {
    errorCode: code,
    message: row.what,
    what: row.what,
    impact: row.impact,
    nextStep: row.nextStep,
    traceId,
    ...(details ? { details } : {}),
  }
}

export function statusOf(code: ErrorCode): number {
  return ERROR_TABLE[code].status
}
