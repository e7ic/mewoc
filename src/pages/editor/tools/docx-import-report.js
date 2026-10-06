/**
 * 报告类 DOCX 内容的静态保留：附加各页眉/页脚一次，将受支持图表的缓存转为数据表。
 * 统一解析包内关系路径并校验资源归属；不查询外链，不读取或执行内嵌工作簿。
 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"

const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const CHART_XML = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const DRAWING_XML = "http://schemas.openxmlformats.org/drawingml/2006/main"
// 图表元素也按命名空间识别，不依赖 c: 前缀或碰巧同名的其它 XML 节点。
const chartChild = (node, name) => getXmlChildren(node).find(child => child.namespaceURI === CHART_XML && child.localName === name)

/** 从 owner 对应的 .rels 中找唯一 ID，可进一步校验关系类型；缺失或重名说明归属不可靠。 */
function relationship(parts, owner, id, type) {
  const segments = owner.split("/")
  const file = segments.pop()
  const relations = parts.get([...segments, "_rels", `${file}.rels`].join("/"))
  const matches = Array.from(relations?.getElementsByTagNameNS(PACKAGE_XML, "Relationship") || []).filter(node => node.getAttribute("Id") === id)
  if (matches.length !== 1 || (type && !matches[0].getAttribute("Type").endsWith(`/${type}`))) throw new Error("Word 内容的资源关系缺失或类型不匹配，请保留原 DOCX")
  return matches[0]
}

// 只解析包内路径；不能把外链、查询参数或越过包根的路径交给文件读取器。
function partTarget(owner, relation) {
  const target = relation.getAttribute("Target")
  if (!target || relation.getAttribute("TargetMode") === "External" || /[:\\?#]/.test(target)) throw new Error("此报告需要内嵌资源，不支持外部数据链接")
  const path = target.startsWith("/") ? [] : owner.split("/").slice(0, -1)
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (!path.length) throw new Error("Word 资源路径超出文档范围")
      path.pop()
    } else path.push(segment)
  }
  return path.join("/")
}

/** 以真正 XML 文本节点封装说明或数据值，避免字符串被当作 OOXML 标记拼入文档。 */
export function createWordParagraph(xml, value) {
  const paragraph = xml.createElementNS(WORD_XML, "w:p")
  const run = xml.createElementNS(WORD_XML, "w:r")
  const text = xml.createElementNS(WORD_XML, "w:t")
  text.appendChild(xml.createTextNode(value))
  run.appendChild(text)
  paragraph.appendChild(run)
  return paragraph
}

/**
 * 将正文已引用且含内容的页眉/页脚复制到正文末尾，插在末尾 sectPr 前以保持合法 Word 结构。
 * 同一部件只保留一次；复制后重映射关系 ID，使图片/链接/图表仍指向原包内资源。
 */
export function appendDocxPageContent(parts, warnings) {
  const xml = parts.get("word/document.xml")
  const body = getWordChild(xml.documentElement, "body")
  const mainRelations = parts.get("word/_rels/document.xml.rels")
  // used 防止多节共用的页内容重复；ids 防止新增关系与主文档已有关系 ID 冲突。
  const used = new Set()
  const ids = new Set(Array.from(mainRelations?.getElementsByTagNameNS(PACKAGE_XML, "Relationship") || []).map(node => node.getAttribute("Id")))
  for (const kind of ["header", "footer"]) {
    for (const reference of Array.from(xml.getElementsByTagNameNS(WORD_XML, `${kind}Reference`))) {
      const path = partTarget("word/document.xml", relationship(parts, "word/document.xml", reference.getAttributeNS(REL_XML, "id"), kind))
      if (used.has(path)) continue
      used.add(path)
      const part = parts.get(path)
      if (!part || part.documentElement.namespaceURI !== WORD_XML || part.documentElement.localName !== (kind === "header" ? "hdr" : "ftr")) throw new Error("页眉、页脚部件缺失或无效，请保留原 DOCX")
      const blocks = getXmlChildren(part.documentElement)
      if (blocks.some(node => node.namespaceURI !== WORD_XML || !["p", "tbl"].includes(node.localName))) throw new Error("页眉、页脚包含暂不支持的结构，请保留原 DOCX")
      if (!hasPageContent(part)) continue
      // importNode 复制到主文档，源部件不变；每个页部件的源关系 ID 用独立 remapped 映射。
      const copies = blocks.map(node => xml.importNode(node, true))
      const remapped = new Map()
      for (const block of copies) {
        for (const node of [block, ...Array.from(block.getElementsByTagNameNS("*", "*"))]) {
          for (const attr of Array.from(node.attributes || []).filter(item => item.namespaceURI === REL_XML)) {
            // 同一源资源关系只复制一次；内部 target 转成包根路径，避免改变 owner 后相对路径失效。
            if (!remapped.has(attr.value)) {
              const source = relationship(parts, path, attr.value)
              if (!["image", "hyperlink", "chart"].some(type => source.getAttribute("Type").endsWith(`/${type}`))) throw new Error("页眉、页脚包含暂不支持的资源类型")
              // 主文档 ID 集合也包含前面追加的资源，循环补后缀保证每次新增关系都唯一。
              let id = `mewocPage${ids.size}`
              while (ids.has(id)) id += "x"
              ids.add(id)
              const copy = mainRelations.importNode(source, true)
              copy.setAttribute("Id", id)
              if (source.getAttribute("TargetMode") !== "External") copy.setAttribute("Target", `/${partTarget(path, source)}`)
              mainRelations.documentElement.appendChild(copy)
              remapped.set(attr.value, id)
            }
            node.setAttributeNS(REL_XML, attr.name, remapped.get(attr.value))
          }
        }
      }
      const section = getWordChild(body, "sectPr") || null
      body.insertBefore(createWordParagraph(xml, `原文${kind === "header" ? "页眉" : "页脚"}（静态内容）`), section)
      copies.forEach(node => body.insertBefore(node, section))
      warnings.add("原文各页眉、页脚的内容已各保留一次并附在正文末尾，不再按页重复；页码为原文件保存值")
    }
  }
  // 包内有正文未引用但含内容的页部件时无法判断是有效内容还是旧残留，明确拒绝以免遗漏。
  for (const [path, part] of parts) {
    if (/^word\/(header|footer)\d*\.xml$/.test(path) && !used.has(path) && hasPageContent(part)) throw new Error("页眉、页脚未被正文引用，无法确定其归属，请保留原 DOCX")
  }
}

/** 文字或可见资源节点都算内容；纯空白页部件跳过，含图片的无文字页仍必须保留。 */
function hasPageContent(part) {
  return part.documentElement.textContent.trim() || ["drawing", "pict", "txbxContent"].some(name => part.getElementsByTagNameNS(WORD_XML, name).length)
}

/**
 * 从字面量或引用附带的缓存读取系列名/分类/数值，不根据工作表公式推算。
 * 按 idx 重排缓存点并要求每个位置恰好出现一次；numeric 模式另验有限数值，但返回原字符串。
 */
function readCache(container, numeric = false) {
  const children = getXmlChildren(container)
  if (children.length !== 1) throw new Error("图表数据格式暂不支持，请保留原 DOCX")
  const source = children[0]
  const cache = ["strLit", "numLit"].includes(source.localName) ? source : chartChild(source, source.localName === "strRef" ? "strCache" : "numCache")
  if (source.namespaceURI !== CHART_XML || !["strLit", "numLit", "strRef", "numRef"].includes(source.localName) || !cache) throw new Error("图表缺少已保存的数据，不能只根据工作表引用猜测内容，请先在 Word 中更新图表并保存")
  const countValue = chartChild(cache, "ptCount")?.getAttribute("val")
  const count = Number(countValue)
  if (!/^\d+$/.test(countValue || "") || !Number.isInteger(count) || count > 2000) throw new Error("图表数据点数量无效或超过 2000 项")
  // 用 null 标记未填位置，允许合法空分类文字，同时识别缺点、重复点和索引越界。
  const values = Array(count).fill(null)
  for (const point of getXmlChildren(cache).filter(node => node.namespaceURI === CHART_XML && node.localName === "pt")) {
    const index = Number(point.getAttribute("idx"))
    const value = chartChild(point, "v")?.textContent
    if (!/^\d+$/.test(point.getAttribute("idx")) || index >= count || values[index] !== null || value === undefined || (numeric && (!value.trim() || !Number.isFinite(Number(value))))) throw new Error("图表数据点缺失、重复或数值无效，请保留原 DOCX")
    values[index] = value
  }
  if (values.some(value => value === null)) throw new Error("图表缓存包含缺失数据点，请保留原 DOCX")
  return values
}

// 图表转为带标题和系列名的数据表；不读取内嵌工作簿，更不执行工作簿公式。
export function createDocxChartReader(parts, warnings, embeddedFiles) {
  // 只有成功读取图表后确认的 XLSX 附属数据才允许被忽略；归档阶段据此拒绝其它嵌入对象。
  const allowedEmbeddings = new Set()
  // 每个 drawing 只允许一个独立图表，组合图形/组合类型没有无歧义的数据表映射。
  const read = drawing => {
    const references = Array.from(drawing.getElementsByTagNameNS(CHART_XML, "chart"))
    const graphics = Array.from(drawing.getElementsByTagNameNS(DRAWING_XML, "graphicData"))
    if (references.length !== 1 || graphics.length !== 1 || getXmlChildren(graphics[0]).length !== 1) throw new Error("组合图表无法可靠转换，请保留原 DOCX")
    const path = partTarget("word/document.xml", relationship(parts, "word/document.xml", references[0].getAttributeNS(REL_XML, "id"), "chart"))
    const chart = parts.get(path)
    const root = chartChild(chart?.documentElement, "chart")
    const plot = chartChild(root, "plotArea")
    const types = getXmlChildren(plot).filter(node => node.localName.endsWith("Chart"))
    if (types.length !== 1 || types[0].namespaceURI !== CHART_XML || !["barChart", "pieChart", "lineChart"].includes(types[0].localName)) throw new Error("仅支持将普通柱形、折线或饼图的缓存数据转为表格，请保留原 DOCX")
    const series = getXmlChildren(types[0]).filter(node => node.namespaceURI === CHART_XML && node.localName === "ser")
    if (!series.length || series.length > 20) throw new Error("图表系列数量无效或过多")
    // 每系列的名称、分类与数值分别验证，系列名无缓存时才用明确的默认说明。
    const data = series.map((node, index) => {
      const tx = chartChild(node, "tx")
      const directName = chartChild(tx, "v")
      const names = tx && !directName ? readCache(tx) : [directName?.textContent || `系列 ${index + 1}`]
      if (names.length !== 1) throw new Error("图表系列名称无法对应")
      const categories = readCache(chartChild(node, "cat"))
      const values = readCache(chartChild(node, "val"), true)
      if (categories.length !== values.length) throw new Error("图表分类与数值数量不一致，请保留原 DOCX")
      return { name: names[0], categories, values }
    })
    // 共用分类轴必须完全一致，且生成后的总单元格数不能超出 JSON 表格导入限额。
    const categories = data[0].categories
    if (data.some(item => JSON.stringify(item.categories) !== JSON.stringify(categories)) || (categories.length + 1) * (data.length + 1) > 10000) throw new Error("图表系列分类不一致或表格过大，请保留原 DOCX")
    const xml = drawing.ownerDocument
    const title = Array.from(chartChild(root, "title")?.getElementsByTagNameNS(DRAWING_XML, "t") || []).map(node => node.textContent).join("")
    const blocks = [createWordParagraph(xml, `${title || "原文图表"}（${{ barChart: "柱形图", pieChart: "饼图", lineChart: "折线图" }[types[0].localName]}数据）`)]
    // 非空图表生成第一列分类、其余列系列值的规则表格；空图表保留标题和系列说明。
    if (categories.length) {
      const table = xml.createElementNS(WORD_XML, "w:tbl")
      const grid = xml.createElementNS(WORD_XML, "w:tblGrid")
      for (let i = 0; i <= data.length; i += 1) grid.appendChild(xml.createElementNS(WORD_XML, "w:gridCol"))
      table.appendChild(grid)
      const rows = [["分类", ...data.map(item => item.name)], ...categories.map((category, i) => [category, ...data.map(item => item.values[i])])]
      rows.forEach(values => {
        const row = xml.createElementNS(WORD_XML, "w:tr")
        values.forEach(value => {
          const cell = xml.createElementNS(WORD_XML, "w:tc")
          cell.appendChild(createWordParagraph(xml, value))
          row.appendChild(cell)
        })
        table.appendChild(row)
      })
      blocks.push(table)
    } else blocks.push(createWordParagraph(xml, `此图表未保存数据点；系列：${data.map(item => item.name).join("、")}`))
    // externalData 在此只用于确认 XLSX 关系合法，不解包工作簿，也不从中补缓存缺失的数据。
    for (const external of Array.from(chart.getElementsByTagNameNS(CHART_XML, "externalData"))) {
      const workbook = partTarget(path, relationship(parts, path, external.getAttributeNS(REL_XML, "id"), "package"))
      if (!/^word\/embeddings\/[^/]+\.xlsx$/i.test(workbook) || !embeddedFiles.has(workbook)) throw new Error("图表工作簿引用无效或类型不受支持，请保留原 DOCX")
      allowedEmbeddings.add(workbook)
    }
    warnings.add("原生图表已按文件中保存的缓存数据转为普通数据表（空图表保留说明）；图形外观、数值显示格式和工作簿公式不保留，数据不会自动更新")
    return blocks
  }
  return { read, allowedEmbeddings }
}
