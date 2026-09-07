import { File } from "node:buffer"
import { webcrypto } from "node:crypto"

// Node 18 尚未默认暴露这些浏览器 API，仅在 Node 测试进程补齐。
if (!globalThis.File) globalThis.File = File
if (!globalThis.crypto) globalThis.crypto = webcrypto
