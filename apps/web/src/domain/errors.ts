/**
 * 错误 → 三段式文案（domain，纯函数）。
 * PRD §6.3：①发生了什么（真实原因，含关键标识）②影响 ③下一步。
 * 前端不按 HTTP 状态自造文案；只按 errorCode 查表（api-spec §1.2 硬规则 3）。
 */
import type { ApiErrorBody } from '@/api/types'

export interface ErrorExplanation {
  code: string
  what: string
  impact: string
  nextStep: string
  traceId: string
  severity: 'error' | 'warn'
}

const TABLE: Record<string, { what: string; impact: string; nextStep: string; severity?: 'error' | 'warn' }> = {
  'auth.session_expired': { what: '登录状态已失效。', impact: '当前页面停止加载，不会展示项目内容。', nextStep: '重新登录后会回到原页面。' },
  'auth.forbidden': { what: '你的账号没有该操作权限。', impact: '操作未执行，数据未改变。', nextStep: '按提示联系项目拥有者或管理员。' },
  'authz.forbidden': { what: '服务端拒绝了越权请求。', impact: '操作未执行，现有数据未改变。', nextStep: '确认所需权限后由有权限的人执行。' },
  'authz.unavailable': { what: '权限系统当前不可用，写操作已全部拒绝（fail-closed）。', impact: '没有产生“看起来成功”的假象；已运行环境不受影响。', nextStep: '稍后重试；持续失败把 traceId 给系统管理员。' },
  'project.name_conflict': { what: '项目名已被使用。', impact: '本项目未创建。', nextStep: '换一个名称，或联系该项目拥有者。' },
  'project.template_unavailable': { what: '所选模板版本已下线或暂时读不到。', impact: '没有创建空仓库，也没有静默换模板。', nextStep: '改用空白模板，或联系系统管理员。' },
  'project.quota_exceeded': { what: '磁盘水位已达阈值。', impact: '新项目/新环境被拒绝；已运行项目不受影响。', nextStep: '联系系统管理员处理容量。' },
  'preview.limit_reached': { what: '预览数量已达上限 3（按未删除记录计数）。', impact: '没有自动淘汰任何预览。', nextStep: '先删除不再需要的预览；停止/休眠不释放名额。' },
  'preview.branch_exists': { what: '该分支已经有预览。', impact: '未重复创建。', nextStep: '打开已有预览，或先删除再创建。' },
  'preview.wake_timeout': { what: '唤醒超时（已等待 60 秒）。', impact: '预览仍为休眠状态，没有对外提供服务。', nextStep: '重试唤醒，或查看运行日志确认应用是否启动成功。' },
  'preview.delete_failed': { what: '预览删除未完成，资源仍残留。', impact: '已标记「残留」并保持名额占用。', nextStep: '联系系统管理员按 GAP-05 清理残留。' },
  'deploy.busy': { what: '该环境已有发布或回滚进行中。', impact: '本次提交被拒绝，不会并行执行。', nextStep: '等待当前任务完成；同一环境发布与回滚互斥。' },
  'deploy.backup_paused': { what: '已暂停新发布（备份或异地同步失败）。', impact: '只阻止新发布；已运行环境继续服务。', nextStep: '等系统管理员按流程处理并解除暂停（解除机制 T-08 未定，无自动恢复开关）。' },
  'deploy.backup_failed': { what: '发布前备份失败，已停止发布。', impact: '仍在原版本，未创建版本标签，流量未切换。', nextStep: '查看备份失败原因，或联系系统管理员后重发。' },
  'deploy.health_check_failed': { what: '健康检查未通过，已自动退回上一健康版本。', impact: '对外仍是上一个健康版本；数据库未改动。', nextStep: '查看构建/运行日志，修好后重发。' },
  'deploy.build_failed': { what: '构建失败。', impact: '没有切换流量，原版本继续服务。', nextStep: '按日志修复代码后重发；发布不会自动重试。' },
  'deploy.timeout': { what: '发布超时（30 分钟），按失败处理。', impact: '未自动重试，未切换流量。', nextStep: '联系系统管理员排查后再发起。' },
  'deploy.version_duplicate': { what: '版本标签已存在。', impact: '未发起发布。', nextStep: '换一个未使用的版本标签。' },
  'deploy.version_invalid': { what: '版本标签格式不正确。', impact: '未发起发布。', nextStep: '按 v1.2.0 格式填写。' },
  'deploy.record_missing': { what: '该版本的记录/镜像已被底座回收。', impact: '不能回退到该版本；当前版本继续服务。', nextStep: '选择一条「可回退」的记录，或重新发布。' },
  'deploy.smoke_failed': { what: '回滚后业务冒烟未连续 2 次通过。', impact: '已保留现场并通知系统管理员，不会自动再次回滚。', nextStep: '查看冒烟结果与运行日志，由系统管理员处理。' },
  'deploy.reason_required': { what: '回退到更早版本必须填写原因。', impact: '未发起回滚。', nextStep: '填写原因后重试。' },
  'share.not_found': { what: '该分享链接不存在或已撤销。', impact: '该链接不可用；项目授权不受影响。', nextStep: '刷新分享列表。' },
  'file.storage_unavailable': { what: '文件存储暂不可用。', impact: '当前无法浏览/下载；应用运行不受影响。', nextStep: '重试；持续失败联系系统管理员。' },
  'log.archive_failed': { what: '历史日志转存失败。', impact: '当前只显示实时日志，没有静默丢弃。', nextStep: '重试转存。' },
  'log.ai_unavailable': { what: 'AI 分析暂不可用（内部网关超时或额度不足）。', impact: '已回退规则高亮，页面功能不受阻。', nextStep: '稍后再试；不会重复扣费。' },
  'grant.subject_not_found': { what: '授权对象账号不存在或已停用。', impact: '该条未生效，其他条不受影响。', nextStep: '确认对方仍在组织内，或改用项目组授权。' },
  'grant.exists': { what: '该对象已存在同一授权。', impact: '未重复添加。', nextStep: '无需操作；授权只有「可见」一档。' },
  'system.param_raise_forbidden': { what: '按既定规则，压测后并发与队列只可下调、不可上调。', impact: '参数未改变，正在运行与排队的任务不受影响。', nextStep: '如需上调，另行变更需求并由系统管理员评估。' },
  'system.param_out_of_range': { what: '参数超出允许范围。', impact: '参数未改变。', nextStep: '填写范围内的整数后重试。' },
  'system.confirm_mismatch': { what: '确认词/确认名不一致。', impact: '操作未执行。', nextStep: '按提示完整输入后重试。' },
  'request.param_unknown': { what: '请求包含未知参数。', impact: '请求被拒绝，避免“以为筛了其实没筛”。', nextStep: '刷新页面重试；持续出现请反馈给开发。' },
  'request.not_found': { what: '请求的资源不存在。', impact: '没有返回任何业务数据。', nextStep: '刷新页面或返回上一级。' },
  'deploy.queue_full': { what: '发布队列已满（上限 10）。', impact: '本次未入队。', nextStep: '稍后重试，不要重复提交。' },
}

export function explainError(body: Pick<ApiErrorBody, 'errorCode' | 'message' | 'nextStep' | 'traceId'> | Error): ErrorExplanation {
  // 注意：ApiError 继承 Error 且带 errorCode，必须先按 errorCode 判定，否则会被当成未知错误
  const b = body as { errorCode?: unknown; message?: string; nextStep?: string; traceId?: string }
  const code = b.errorCode
  if (typeof code === 'string' && code) {
    const row = TABLE[code]
    if (row) {
      return { code, what: `${row.what}`, impact: row.impact, nextStep: b.nextStep || row.nextStep, traceId: b.traceId ?? '—', severity: row.severity ?? 'error' }
    }
    return {
      code,
      what: b.message || '操作未完成。',
      impact: '操作未生效；已有数据未被修改。',
      nextStep: b.nextStep || '重试；持续失败请把 errorCode 与 traceId 给管理员。',
      traceId: b.traceId ?? '—',
      severity: 'error',
    }
  }
  return {
    code: 'request.unknown',
    what: '请求未能完成。',
    impact: '操作未生效。',
    nextStep: '重试一次；仍失败请把 traceId 给管理员。',
    traceId: '—',
    severity: 'error',
  }
}

/** 渲染成固定三段（测试断言顺序与字段齐全） */
export function formatError(e: ErrorExplanation): { head: string; lines: string[] } {
  return {
    head: `【发生了什么】${e.what}`,
    lines: [`【影响】${e.impact}`, `【下一步】${e.nextStep}`, `错误码：${e.code} · traceId：${e.traceId}`],
  }
}
