/**
 * 定义可重复读取的内置写作模板及模板化时的批注清理。
 * 内置结构通过统一文档校验生成；模板是开始新写作的结构，不继承来源文档的审阅线程。
 */
import { createDocument, validateDocument } from "./document-schema.js"

export const MAX_TEMPLATE_NAME_LENGTH = 100
export const BUILTIN_TEMPLATE_PREFIX = "builtin-template-"
const BUILTIN_TIME = "2026-10-01T00:00:00.000Z"

// 轻量节点构造器直接生成 schema JSON，空段落省略 content；列表项和表格单元格都保留段落容器。
const paragraph = text => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })
const heading = (text, level = 2) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] })
const list = items => ({ type: "bulletList", content: items.map(text => ({ type: "listItem", content: [paragraph(text)] })) })
const table = rows => ({
  type: "table",
  content: rows.map((row, index) => ({
    type: "tableRow",
    content: row.map(text => ({ type: index ? "tableCell" : "tableHeader", content: [paragraph(text)] }))
  }))
})

// 内置模板只提供可编辑的写作结构，不混入用户文档、审阅意见或外部资源。
// 固定 ID 和时间让列表及文件快照可重复验证；每次读取交付独立克隆，调用方不能修改定义。
const builtinDefinitions = [
  {
    id: "builtin-template-meeting", name: "会议纪要", description: "整理会议背景、讨论结论与行动项。",
    content: [
      heading("会议纪要", 1), paragraph("会议主题：请填写主题"), paragraph("时间与地点：请填写"), paragraph("参会人员：请填写"),
      heading("会议议题"), list(["议题一：请填写讨论目标", "议题二：请填写待确认事项"]),
      heading("讨论与结论"), paragraph("记录关键事实、达成的共识，以及仍需确认的问题。"),
      heading("行动项"), table([["事项", "负责人", "完成时间"], ["请填写后续任务", "请填写", "请填写"]]),
      heading("后续安排"), paragraph("说明下次跟进时间和需要补充的材料。")
    ]
  },
  {
    id: "builtin-template-weekly", name: "项目周报", description: "汇总本周进展、风险与下周计划。",
    content: [
      heading("项目周报", 1), paragraph("项目名称：请填写"), paragraph("报告周期：请填写"), paragraph("汇报人：请填写"),
      heading("本周概况"), paragraph("简述本周目标、实际结果与整体进度。"),
      heading("重点工作"), table([["工作内容", "进展与结果", "状态"], ["请填写", "请填写可核对的成果", "进行中 / 已完成"]]),
      heading("风险与支持"), list(["风险：请说明影响及应对措施", "需要支持：请填写协助事项与时间"]),
      heading("下周计划"), list(["计划一：请填写目标和交付时间", "计划二：请填写负责人及验收方式"])
    ]
  },
  {
    id: "builtin-template-report", name: "工作报告", description: "按背景、成果、问题和计划组织报告。",
    content: [
      heading("工作报告", 1), paragraph("报告主题：请填写"), paragraph("报告人及日期：请填写"),
      heading("一、背景与目标"), paragraph("说明工作背景、范围和预期目标。"),
      heading("二、主要成果"), list(["成果一：请填写完成情况与依据", "成果二：请填写实际价值及影响"]),
      table([["目标", "实际结果", "说明"], ["请填写", "请填写", "请填写差异及原因"]]),
      heading("三、问题与改进"), paragraph("列出已发现的问题、原因和改进措施。"),
      heading("四、后续计划"), list(["下一步重点：请填写", "负责人及时间：请填写"])
    ]
  }
]

// 将描述性模板定义变成完整文档，固定身份与时间后立即校验，尽早发现内置结构不兼容。
const builtinTemplates = builtinDefinitions.map(({ content, ...definition }) => {
  const document = createDocument()
  document.id = definition.id
  document.title = definition.name
  document.createdAt = document.updatedAt = BUILTIN_TIME
  document.content = { type: "doc", content }
  validateDocument(document)
  return { ...definition, builtin: true, createdAt: BUILTIN_TIME, updatedAt: BUILTIN_TIME, storageVersion: 0, document }
})

// 列表只返回独立元信息副本，不暴露可修改的内置正文对象。
export function getBuiltinDocumentTemplates() {
  return builtinTemplates.map(({ document: _document, ...metadata }) => structuredClone(metadata))
}

// 按固定身份查找完整模板并深克隆；未知 ID 返回 null，让仓库继续查询用户模板。
export function getBuiltinDocumentTemplate(id) {
  const template = builtinTemplates.find(item => item.id === id)
  return template ? structuredClone(template) : null
}

/**
 * 模板用于重新开始写作，已有批注属于原稿的审阅过程，不应传播到后续文档。
 * 只操作克隆后的 JSON：移除根节点线程与全树的定位标记，保留原文、链接、格式、
 * 段落属性及资源引用。它不经 HTML 或编辑器重新解析，避免结构与格式发生隐式变化。
 */
export function stripTemplateComments(document) {
  const copy = structuredClone(document)
  if (copy.content?.attrs) delete copy.content.attrs.commentThreads
  // 根线程和深层文字 marks 必须同时移除，只删其中一部分会留下无意义或无对应线程的锚点。
  const visit = node => {
    if (Array.isArray(node.marks)) node.marks = node.marks.filter(mark => mark.type !== "commentAnchor")
    node.content?.forEach(visit)
  }
  if (copy.content) visit(copy.content)
  return copy
}
