import { getDocuments, getDocumentAssets, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { readPortableFile, createPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import fixture from "./fixtures/m5-current-document.mewoc.json"

// 不改写用户文档：现有记录仅检查 Blob 可读性，重复保存使用独立导入的测试副本。
export async function runAssetPersistenceChecks(report) {
  for (const record of await getDocuments()) {
    try {
      const assets = await getDocumentAssets(record.document)
      for (const asset of assets.values()) await asset.blob.arrayBuffer()
      report({ name: `现有资源可读：${record.document.title}`, passed: true })
    } catch (error) {
      report({ name: `现有资源可读：${record.document.title}`, passed: false, error: `${error.name}: ${error.message}` })
    }
  }
  const record = await readPortableFile(new File([JSON.stringify(fixture)], "fixture.mewoc.json"))
  let assets = record.assets
  let version = 0
  try {
    for (let index = 0; index < 8; index += 1) {
      const saved = await saveLocalDocument(record.document, assets, version)
      version = saved.storageVersion
      // 让提交后的文件回收与下一次读取跨越任务边界，覆盖从 IndexedDB 恢复的 Blob 再写回。
      await new Promise(resolve => setTimeout(resolve, 250))
      assets = await getDocumentAssets(record.document)
      const portable = await createPortableFile(record.document, assets)
      for (const id of Object.keys(fixture.assetData)) {
        if (portable.assetData[id] !== fixture.assetData[id]) throw new Error(`第 ${index + 1} 次保存资源字节变化`)
      }
      report({ name: `资源重复保存与导出第 ${index + 1} 轮`, passed: true })
    }
  } catch (error) {
    report({ name: "资源重复保存与导出", passed: false, error: `${error.name}: ${error.message}` })
  } finally {
    await removeVerificationDocuments([record])
  }
}
