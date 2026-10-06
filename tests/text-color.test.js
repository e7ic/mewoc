/**
 * 验证颜色表单输入的合法性、不透明输出及 HSB 内部缓存/精度保留。
 * 非法或未完成草稿返回 null，单通道编辑不能把其他通道的表单舍入值反写到内部颜色。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createOpaqueTextColor, getTextColorDraft, parseTextColorDraft } from "../src/pages/editor/tools/text-color.js"

test("颜色输入只接受完整的不透明 HEX，未完成或无效草稿不产生可应用颜色", () => {
  const color = createOpaqueTextColor("#123456")
  assert.equal(parseTextColorDraft(color, "hex", { hex: "#f00" }).toHexString(), "#ff0000")
  assert.equal(parseTextColorDraft(color, "hex", { hex: " 00FF00 " }).toHexString(), "#00ff00")
  for (const hex of ["", "f", "ff", "12345", "12345678", "rgba(0,0,0,.5)", "ZZZ"]) {
    assert.equal(parseTextColorDraft(color, "hex", { hex }), null)
  }
  assert.equal(color.toHexString(), "#123456")
})

// 黑色 HEX 无法表达色相，先把亮度设为 0 再恢复，检出从 HEX 重建对象导致用户选中的色相丢失。
test("HSB 在黑色中记住色相，重新增加亮度得到预期蓝色且强制不透明", () => {
  const color = createOpaqueTextColor({ h: 30, s: 1, b: 0, a: 0.2 })
  const draft = { h: 240, s: 100, b: 0 }
  const black = parseTextColorDraft(color, "hsb", draft, new Set(["h"]))
  assert.equal(black.toHexString(), "#000000")
  assert.equal(getTextColorDraft(black, "hsb").h, 240)
  const blue = parseTextColorDraft(black, "hsb", { ...draft, b: 100 }, new Set(["b"]))
  assert.equal(blue.toHexString(), "#0000ff")
  assert.equal(blue.a, 1)
})

// 源颜色故意带小数饱和度/亮度，显示草稿虽取整，dirty 集合只允许被编辑通道写回。
test("数值草稿拒绝越界、空值和小数，编辑一个通道保留其他通道的原始精度", () => {
  const color = createOpaqueTextColor({ h: 28.25, s: 0.333, b: 0.567 })
  const draft = getTextColorDraft(color, "hsb")
  const next = parseTextColorDraft(color, "hsb", { ...draft, h: 90 }, new Set(["h"]))
  assert.equal(next.toHsb().h, 90)
  assert.equal(next.toHsb().s, 0.333)
  assert.equal(next.toHsb().b, 0.567)
  for (const r of ["", null, -1, 256, 1.5, "abc"]) {
    assert.equal(parseTextColorDraft(color, "rgb", { r, g: 0, b: 0 }, new Set(["r"])), null)
  }
  const green = parseTextColorDraft(color, "rgb", { r: 0, g: 255, b: 0 }, new Set(["r", "g", "b"]))
  assert.equal(green.toHexString(), "#00ff00")
})
