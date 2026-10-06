/** Node 测试的浏览器 API 兼容入口；由 package.json 的 --import 在所有测试执行前加载。 */
import { File } from "node:buffer"
import { webcrypto } from "node:crypto"

// Node 18 尚未默认暴露这些浏览器 API，仅在 Node 测试进程补齐。
// 保留较新 Node 的原生实现，仅填补缺失 API，不替换测试所处环境已有的全局对象。
if (!globalThis.File) globalThis.File = File
if (!globalThis.crypto) globalThis.crypto = webcrypto
