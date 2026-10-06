/**
 * 确定的 PCM WAV 与浏览器原生录制视频，专用于开发验收，不访问外部媒体或用户文件。
 * WAV 可供 Node 比对原始字节；视频只在用户点击开发验收按钮后通过独立 Canvas 流生成。
 */
export function createWaveFile(name = "M24-音频验收.wav") {
  const rate = 8000
  const samples = rate * 4
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const label = (offset, value) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)))
  label(0, "RIFF")
  view.setUint32(4, buffer.byteLength - 8, true)
  label(8, "WAVE")
  label(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  label(36, "data")
  view.setUint32(40, samples * 2, true)
  for (let sample = 0; sample < samples; sample += 1) {
    view.setInt16(44 + sample * 2, Math.round(Math.sin(sample * Math.PI * 2 * 440 / rate) * 800), true)
  }
  return new File([buffer], name, { type: "audio/wav" })
}

/** MPEG-1 Layer III 静音帧：128 kbps / 44.1 kHz，零长度 granule，供原生解码器实测。 */
export function createMp3File(name = "M24-静音验收.mp3") {
  const frameBytes = 417
  const bytes = new Uint8Array(frameBytes * 154)
  for (let frame = 0; frame < 154; frame += 1) bytes.set([0xff, 0xfb, 0x90, 0x64], frame * frameBytes)
  return new File([bytes], name, { type: "audio/mpeg" })
}

async function recordVideo(mimeType, extension) {
  const canvas = document.createElement("canvas")
  canvas.width = 480
  canvas.height = 270
  const context = canvas.getContext("2d")
  if (!context || !canvas.captureStream) throw new Error("当前验收浏览器不支持生成 Canvas 视频样例")
  let frame = 0
  const draw = () => {
    context.fillStyle = frame % 2 ? "#6554c0" : "#168c9b"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = "#fff"
    context.font = "bold 30px Arial"
    context.fillText("Mewoc · M24", 35, 75)
    context.font = "20px Arial"
    context.fillText("Local media playback", 35, 120)
    context.fillRect(35 + frame % 12 * 28, 165, 70, 45)
    frame += 1
  }
  draw()
  const stream = canvas.captureStream(8)
  let recorder
  let ticker
  let stopTimer
  let deadline
  try {
    return await new Promise((resolve, reject) => {
      const chunks = []
      let settled = false
      const finish = error => {
        if (settled) return
        settled = true
        clearInterval(ticker)
        clearTimeout(stopTimer)
        clearTimeout(deadline)
        if (error) reject(error)
        else {
          const file = new File(chunks, `M24-视频验收.${extension}`, { type: `video/${extension}` })
          if (!file.size) reject(new Error("浏览器未能编码视频样例"))
          else resolve(file)
        }
      }
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 180000 })
      recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data) })
      recorder.addEventListener("error", () => finish(new Error("浏览器视频样例编码失败")))
      recorder.addEventListener("stop", () => finish())
      recorder.start(200)
      ticker = setInterval(draw, 125)
      stopTimer = setTimeout(() => { if (recorder.state !== "inactive") recorder.stop() }, 3600)
      deadline = setTimeout(() => finish(new Error("视频样例编码超时，请将验收页切到前台重试")), 15000)
    })
  } finally {
    clearInterval(ticker)
    clearTimeout(stopTimer)
    clearTimeout(deadline)
    if (recorder?.state !== "inactive") recorder?.stop()
    stream.getTracks().forEach(track => track.stop())
    canvas.width = 0
    canvas.height = 0
  }
}

let fixtures
export function createMediaFixtures() {
  if (fixtures) return fixtures
  fixtures = (async () => {
    const webm = ["video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type))
    if (!webm) throw new Error("当前验收浏览器不能录制 WebM 样例")
    const mp4 = ["video/mp4;codecs=avc1.42001E", "video/mp4"].find(type => MediaRecorder.isTypeSupported(type))
    const [video, optionalMp4] = await Promise.all([recordVideo(webm, "webm"), mp4 ? recordVideo(mp4, "mp4") : null])
    return { audio: createWaveFile(), mp3: createMp3File(), video, mp4: optionalMp4 }
  })().catch(error => { fixtures = null; throw error })
  return fixtures
}
