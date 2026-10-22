/** 混合长文夹具：同时覆盖四批分页能力，所有内容和资源均由验收生成。 */
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { TEXT_BOX_DEFAULTS } from "../src/pages/editor/tools/block-containers.js"

export const SOAK_END_TEXT = "M25_SOAK_DOCUMENT_END"

const paragraph = text => ({
  type: "paragraph",
  content: [
    {
      type: "text",
      text
    }
  ]
})

function createList(type, count) {
  return {
    type,
    ...(type === "orderedList" && {
      attrs: {
        start: 7,
        type: "a"
      }
    }),
    content: Array.from({
      length: count
    }, (_item, index) => ({
      type: type === "taskList" ? "taskItem" : "listItem",
      ...(type === "taskList" && { attrs: { checked: index % 3 === 0 } }),
      content: [paragraph(`${index + 1} · 连续重排保留原始项目、编号和勾选状态。`.repeat(2))]
    }))
  }
}

function createTable() {
  const columns = [0, 1]
  return {
    type: "table",
    content: Array.from({
      length: 48
    }, (_item, row) => ({
      type: "tableRow",
      content: columns.map(column => ({
        type: row ? "tableCell" : "tableHeader",
        attrs: {
          colspan: 1,
          rowspan: 1,
          colwidth: [180]
        },
        content: [paragraph(`持续验收表格 ${row + 1} / ${column + 1}`)]
      }))
    }))
  }
}

export function createPaginationSoakDocument() {
  const source = createDocument()
  const code = Array.from({
    length: 90
  }, (_item, index) => `const line${index} = ${index}`)
  source.title = `M25 持续验收-${source.id}`
  source.page.header = {
    text: "M25 持续验收",
    alignment: "left",
    pageNumber: "page"
  }
  source.page.footer = {
    text: "原始文档与资源",
    alignment: "center",
    pageNumber: "page-total"
  }
  source.content = {
    type: "doc",
    content: [
      paragraph("M25_SOAK_DOCUMENT_START"),
      paragraph("同一段中英文 Mixed text 👩🏽‍💻 跨页后仍保持完整，保存和撤销不能加入视图空隙。".repeat(110)),
      createTable(),
      createList("orderedList", 48),
      {
        type: "textBox",
        attrs: { ...TEXT_BOX_DEFAULTS },
        content: [
          paragraph("嵌套容器开始"),
          {
            type: "details",
            attrs: { summary: "持续收起与展开" },
            content: [
              {
                type: "blockquote",
                content: [
                  paragraph("引用中的长段落持续跨页，正文只存在一份。".repeat(80)),
                  createList("taskList", 24)
                ]
              }
            ]
          },
          paragraph("嵌套容器结束")
        ]
      },
      {
        type: "codeBlock",
        attrs: { language: "javascript" },
        content: [
          {
            type: "text",
            text: code.join("\n")
          }
        ]
      },
      { type: "pageBreak" },
      paragraph(SOAK_END_TEXT)
    ]
  }
  return source
}

export async function createPaginationSoakImage() {
  const canvas = document.createElement("canvas")
  canvas.width = 240
  canvas.height = 120
  const context = canvas.getContext("2d")
  context.fillStyle = "#6657d9"
  context.fillRect(0, 0, canvas.width, canvas.height)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  return new File([
    blob
  ], "M25-soak.png", {
    type: "image/png"
  })
}
