/**
 * 从已安装的运行时依赖及其传递依赖收集版本、声明许可证和可获得的许可证正文。
 * 生成 public 通知与 docs 清单；同文许可证合并展示，仅处理 dependencies，不扫描开发依赖。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = process.cwd()
const PACKAGES = new Map()
const GROUPS = new Map()
// 个别发布包未携带正文时使用已保存的固定版本原始许可材料；URL 仅作出处记录，不联网下载。
const LICENSE_SOURCES = {
  "hash.js@1.1.7": {
    file: "docs/licenses/hash-js.txt",
    url: "https://github.com/indutny/hash.js/blob/v1.1.7/README.md#license"
  },
  "isarray@1.0.0": {
    file: "docs/licenses/isarray-1.txt",
    url: "https://github.com/juliangruber/isarray/blob/v1.0.0/README.md#license"
  },
  "isarray@2.0.5": {
    file: "docs/licenses/isarray.txt",
    url: "https://github.com/juliangruber/isarray/blob/v2.0.5/LICENSE"
  },
  "@ant-design/icons-svg@4.6.0": {
    file: "docs/licenses/ant-design-icons-svg.txt",
    url: "https://github.com/ant-design/ant-design-icons/blob/7f2516ac91226d2b41f93b35cb5197c8d94f7189/LICENSE"
  },
  "remark-math@6.0.0": {
    file: "docs/licenses/remark-math.txt",
    url: "https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license"
  }
}

/** 按依赖父包的 Node 解析路径定位实际安装目录并解引用符号链接，兼容同包多版本布局。 */
function getPackageDirectory(name, parent) {
  const require = createRequire(path.join(parent, "package.json"))
  // 有些包只导出子路径，不能 require.resolve 包入口；沿 Node 的模块搜索路径读取元数据。
  // buffer 等浏览器依赖与 Node 内置模块同名，用包子路径取搜索目录，避免得到内置模块的 null。
  const candidates = require.resolve.paths(`${name}/package.json`).map(directory => path.join(directory, name))
  const directory = candidates.find(candidate => fs.existsSync(path.join(candidate, "package.json")))
  if (!directory) throw new Error(`找不到已安装依赖 ${name}`)
  return fs.realpathSync(directory)
}

/** 递归采集运行时依赖；以 name@version 去重并在继续递归前登记，避免共享依赖或依赖环反复处理。 */
function collectPackage(name, parent) {
  const directory = getPackageDirectory(name, parent)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  const id = `${manifest.name}@${manifest.version}`
  if (PACKAGES.has(id)) return
  const files = fs.readdirSync(directory).filter(file => /^(license|licence|copying)(\.|$)/i.test(file))
  const source = LICENSE_SOURCES[id]
  const license = source
    ? fs.readFileSync(path.join(ROOT, source.file), "utf8").trim()
    : files.map(file => fs.readFileSync(path.join(directory, file), "utf8").trim()).join("\n\n")
  PACKAGES.set(id, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    licenseTextIncluded: !!license,
    licenseSource: source?.url || (license ? "installed package" : null),
    repository: manifest.repository
  })
  // 找不到正文时明确写出缺失与声明信息，不把 package.json 的 license 字段冒充完整条款。
  const notice = license || `The published package does not include a license text file.\nDeclared license: ${manifest.license}\nRepository: ${JSON.stringify(manifest.repository)}`
  const packages = GROUPS.get(notice) || []
  packages.push(id)
  GROUPS.set(notice, packages)
  Object.keys(manifest.dependencies || {}).forEach(dependency => collectPackage(dependency, directory))
}

// 从项目运行时依赖启动遍历；结果按包名整理，通知内按版本标识排序，便于审核生成差异。
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
Object.keys(MANIFEST.dependencies).forEach(name => collectPackage(name, ROOT))
const NOTICES = ["Mewoc — installed runtime dependency license inventory", "Generated from installed package metadata and available license files. Missing license texts are explicitly recorded; this inventory is not a completed distribution-license audit. Development-only dependencies are excluded."]
for (const [license, packages] of GROUPS) {
  NOTICES.push(`${packages.sort().join("\n")}\n\n${license}`)
}
// 覆写生成物并统一 LF/去行末空白，让已安装版本变化体现在稳定清单而非格式噪声中。
fs.mkdirSync(path.join(ROOT, "public"), { recursive: true })
fs.writeFileSync(path.join(ROOT, "public/THIRD_PARTY_NOTICES.txt"), `${NOTICES.join("\n\n========================================\n\n")}\n`.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""))
fs.writeFileSync(path.join(ROOT, "docs/runtime-dependencies.json"), `${JSON.stringify([...PACKAGES.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2)}\n`)
// 输出收集数量与缺正文包供维护者复核；本脚本盘点证据，不把缺失材料判作已完成审核。
process.stdout.write(`Collected licenses for ${PACKAGES.size} installed runtime packages\n`)
process.stdout.write(`Packages without bundled license text: ${[...PACKAGES.values()].filter(item => !item.licenseTextIncluded).map(item => item.name).join(", ")}\n`)
