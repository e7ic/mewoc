/**
 * 容器与元数据使用真实 Blob 字节；播放器事件入口仅用于可重复验证失败、取消、超时与 URL 回收。
 * 原生媒体解码/播放由浏览器验收补充，Node 不把事件替身当作编码器支持证明。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { MAX_MEDIA_BYTES } from "../src/pages/editor/constants/editor-constants.js"
import { getMediaFileMetadata, getMediaFileName, getMediaText, readMediaFile, validateMediaBlob, validateMediaMetadata } from "../src/pages/editor/tools/media-assets.js"

const wav = () => {
  const bytes = new Uint8Array(244)
  const view = new DataView(bytes.buffer)
  const write = (start, text) => [...text].forEach((char, index) => { bytes[start + index] = char.charCodeAt(0) })
  write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVE")
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, "data"); view.setUint32(40, 200, true)
  for (let index = 44; index < bytes.length; index += 1) bytes[index] = index % 256
  return bytes
}
const headers = {
  "audio/mpeg": new Uint8Array([255, 251, 144, 0, 1, 2, 3, 4]),
  "audio/wav": wav(),
  "video/mp4": new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 105, 115, 111, 109]),
  "video/webm": new Uint8Array([26, 69, 223, 163, 135, 66, 130, 132, 119, 101, 98, 109, 24, 83, 128, 103, 255])
}
const file = (mime = "audio/wav", name = "原始声音.wav") => new File([headers[mime]], name, { type: mime })
class MediaEvents extends EventTarget {
  constructor({ supported = true, result = "loadedmetadata", duration = 0.0125, width = 32, height = 16 } = {}) {
    super()
    Object.assign(this, { supported, result, duration, videoWidth: width, videoHeight: height, activeListeners: new Set(), loads: 0 })
  }
  canPlayType() { return this.supported ? "probably" : "" }
  addEventListener(type, listener) { this.activeListeners.add(type); super.addEventListener(type, listener) }
  removeEventListener(type, listener) { this.activeListeners.delete(type); super.removeEventListener(type, listener) }
  removeAttribute(name) { if (name === "src") this.src = "" }
  load() {
    this.loads += 1
    if (this.src && this.result) queueMicrotask(() => this.dispatchEvent(new Event(this.result)))
  }
}
const urls = () => {
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const created = []
  const revoked = []
  URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url }
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
  return { created, revoked, restore: () => { URL.createObjectURL = create; URL.revokeObjectURL = revoke } }
}

test("媒体元数据限定四种 MIME、资源种类、严格名称及 5 MiB 正整数边界", () => {
  for (const [mimeType, kind] of [["audio/mpeg", "audio"], ["audio/wav", "audio"], ["video/mp4", "video"], ["video/webm", "video"]]) {
    assert.doesNotThrow(() => validateMediaMetadata({ kind, mimeType, fileName: "原文件", byteLength: MAX_MEDIA_BYTES }))
    assert.throws(() => validateMediaMetadata({ kind: kind === "audio" ? "video" : "audio", mimeType, fileName: "原文件", byteLength: 1 }), /类型|种类/)
  }
  for (const fileName of ["", " ", "../文件.wav", "目录\\文件.wav", "坏\n名.wav", "a".repeat(256), null]) {
    assert.throws(() => validateMediaMetadata({ fileName, kind: "audio", mimeType: "audio/wav", byteLength: 1 }), /文件名/)
  }
  for (const byteLength of [0, -1, 0.5, NaN, Infinity, MAX_MEDIA_BYTES + 1]) {
    assert.throws(() => validateMediaMetadata({ fileName: "a.wav", kind: "audio", mimeType: "audio/wav", byteLength }), /5 MiB/)
  }
  assert.throws(() => validateMediaMetadata({ fileName: "a.wav", kind: "audio", mimeType: "audio/ogg", byteLength: 1 }), /类型/)
})

test("文件入口只归一化已知 WAV/MP3 别名与受控空 MIME，不放宽持久元数据 MIME", async () => {
  for (const type of ["audio/x-wav", "audio/wave", "audio/x-pn-wav", ""]) {
    const source = new File([wav()], "原始.wav", { type })
    assert.equal(getMediaFileMetadata(source, "audio").mimeType, "audio/wav")
    const asset = await readMediaFile(source, "audio", { createMedia: () => new MediaEvents() })
    try {
      assert.equal(asset.mimeType, "audio/wav")
      assert.equal(asset.blob.type, "audio/wav")
      assert.deepEqual(await asset.blob.arrayBuffer(), await source.arrayBuffer())
    } finally { URL.revokeObjectURL(asset.url) }
  }
  assert.equal(getMediaFileMetadata(new File([headers["audio/mpeg"]], "a.mp3", { type: "audio/mp3" }), "audio").mimeType, "audio/mpeg")
  for (const source of [new File([wav()], "a.bin"), new File([wav()], "a.wav", { type: "text/plain" }), new File([wav()], "a.wav", { type: "audio/wav" })]) {
    assert.throws(() => getMediaFileMetadata(source, "video"), /类型/)
  }
  assert.throws(() => validateMediaMetadata({ fileName: "a.wav", kind: "audio", mimeType: "audio/x-wav", byteLength: 244 }), /类型/)
})

test("四种容器头校验真实 Blob 字节，容器伪造、截断及 kind 冲突均拒绝", async () => {
  for (const [type, bytes] of Object.entries(headers)) await validateMediaBlob(new Blob([bytes], { type }))
  const taggedMp3 = new Blob([new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), headers["audio/mpeg"]], { type: "audio/mpeg" })
  await validateMediaBlob(taggedMp3, { kind: "audio" })
  for (const type of Object.keys(headers)) {
    await assert.rejects(validateMediaBlob(new Blob(["not media"], { type })), /内容|容器/)
    await assert.rejects(validateMediaBlob(new Blob([headers[type].slice(0, 3)], { type })), /内容|容器/)
  }
  const brokenWav = wav(); new DataView(brokenWav.buffer).setUint32(40, 99999, true)
  await assert.rejects(validateMediaBlob(new Blob([brokenWav], { type: "audio/wav" })), /容器/)
  const matroska = headers["video/webm"].slice(); matroska[8] = 109
  await assert.rejects(validateMediaBlob(new Blob([matroska], { type: "video/webm" })), /容器/)
  await assert.rejects(validateMediaBlob(new Blob([wav()], { type: "audio/wav" }), { kind: "video" }), /请选择/)
})

test("原生 metadata 成功后原字节/名称保持，临时播放器不自动播放且无残留监听", async () => {
  const source = file()
  const player = new MediaEvents()
  const tracker = urls()
  try {
    const asset = await readMediaFile(source, "audio", { createMedia: kind => { assert.equal(kind, "audio"); return player } })
    assert.equal(asset.kind, "audio")
    assert.equal(asset.fileName, source.name)
    assert.equal(asset.byteLength, source.size)
    assert.deepEqual(await asset.blob.arrayBuffer(), await source.arrayBuffer())
    assert.deepEqual(await (await fetch(asset.url)).arrayBuffer(), await source.arrayBuffer())
    assert.equal(player.autoplay, false)
    assert.equal(player.preload, "metadata")
    assert.equal(player.src, "")
    assert.equal(player.activeListeners.size, 0)
    assert.deepEqual(tracker.revoked, [])
    URL.revokeObjectURL(asset.url)
  } finally { tracker.restore() }
})

test("原生不支持、解码错误、零/NaN 时长与无画面的视频拒绝且回收所有临时 URL", async () => {
  const tracker = urls()
  try {
    for (const [source, kind, options, pattern] of [
      [file(), "audio", { supported: false }, /不支持/],
      [file(), "audio", { result: "error" }, /无法播放/],
      [file(), "audio", { duration: 0 }, /时长/],
      [file(), "audio", { duration: NaN }, /时长/],
      [file("video/mp4", "a.mp4"), "video", { width: 0 }, /画面/]
    ]) {
      const player = new MediaEvents(options)
      await assert.rejects(readMediaFile(source, kind, { createMedia: () => player }), pattern)
      assert.equal(player.activeListeners.size, 0)
    }
    assert.equal(tracker.created.length, 4)
    assert.deepEqual(tracker.revoked, tracker.created)
  } finally { tracker.restore() }
})

test("有限本地 WebM 未知时长 Infinity 可接纳，不制造总时长元数据", async () => {
  const asset = await readMediaFile(file("video/webm", "录制.webm"), "video", { createMedia: () => new MediaEvents({ duration: Infinity }) })
  try { assert.equal(asset.kind, "video"); assert.equal("duration" in asset, false) } finally { URL.revokeObjectURL(asset.url) }
})

test("播放元数据超时和读取中断都解除监听并回收一次 URL，已取消信号不开始读取", async () => {
  const tracker = urls()
  try {
    const timeoutPlayer = new MediaEvents({ result: null })
    await assert.rejects(readMediaFile(file(), "audio", { createMedia: () => timeoutPlayer, timeoutMs: 5 }), /10 秒/)
    assert.equal(timeoutPlayer.activeListeners.size, 0)
    const controller = new AbortController()
    const pendingPlayer = new MediaEvents({ result: null })
    const pending = readMediaFile(file(), "audio", { signal: controller.signal, createMedia: () => pendingPlayer })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
    assert.equal(pendingPlayer.activeListeners.size, 0)
    let created = false
    await assert.rejects(readMediaFile(file(), "audio", { signal: controller.signal, createMedia: () => { created = true; return new MediaEvents() } }), { name: "AbortError" })
    assert.equal(created, false)
    assert.equal(tracker.created.length, 2)
    assert.deepEqual(tracker.revoked, tracker.created)
  } finally { tracker.restore() }
})

test("原始读取失败/声明长度变化/等待字节时取消均不创建播放 URL", async () => {
  const tracker = urls()
  try {
    const source = file()
    source.arrayBuffer = async () => { throw new Error("unavailable") }
    await assert.rejects(readMediaFile(source, "audio"), /读取失败/)
    source.arrayBuffer = async () => new ArrayBuffer(0)
    await assert.rejects(readMediaFile(source, "audio"), /大小不一致/)
    let finish
    source.arrayBuffer = () => new Promise(resolve => { finish = resolve })
    const controller = new AbortController()
    const pending = readMediaFile(source, "audio", { signal: controller.signal })
    controller.abort(); finish(wav().buffer)
    await assert.rejects(pending, { name: "AbortError" })
    assert.deepEqual(tracker.created, [])
  } finally { tracker.restore() }
})

test("metadata 事件结束与资源返回之间取消仍回收已创建 URL", async () => {
  const tracker = urls()
  const controller = new AbortController()
  const player = new MediaEvents({ result: null })
  player.load = () => {
    if (!player.src) return
    player.dispatchEvent(new Event("loadedmetadata"))
    controller.abort()
  }
  try {
    await assert.rejects(readMediaFile(file(), "audio", { signal: controller.signal, createMedia: () => player }), { name: "AbortError" })
    assert.equal(tracker.created.length, 1)
    assert.deepEqual(tracker.revoked, tracker.created)
  } finally { tracker.restore() }
})

test("标准说明与安全下载名保留音视频种类、原名称及二进制体积", () => {
  assert.equal(getMediaText({ kind: "audio", fileName: "<声音>.wav", byteLength: 1024 }), "[音频：<声音>.wav（1.0 KiB）]")
  assert.equal(getMediaText({ kind: "video", fileName: "a.mp4", byteLength: 1048576 }), "[视频：a.mp4（1.0 MiB）]")
  assert.equal(getMediaText(null), "[音视频资源缺失]")
  assert.equal(getMediaFileName("声音:<草稿>?.wav"), "声音__草稿__.wav")
})
