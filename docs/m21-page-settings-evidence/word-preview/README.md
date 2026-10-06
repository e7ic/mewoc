# M21 DOCX 水印渲染记录

- `watermark.docx` 使用正式 `docx-file.js` 导出入口生成：A5 竖版，四边 15 mm，文字 `Mewoc 水印验证`，颜色 `#AB12EF`，透明度 `0.3`，角度 `-35`。
- `watermark.pdf` 由已有 LibreOfficeDev 26.8.0.0.alpha0 转换，共 6 页；`font-page-1.png`、`font-page-2.png` 是前两页预览。中文正文完整，水印居中、旋转、置于文字后，并逐页重复。
- `long-watermark.mewoc.json` 保存第二个输入；`long-watermark.docx`、对应 PDF 和 `long-page-1.png` 验证 A5 横版、80 个中文码点和 90 度旋转。完整水印留在纸面内，字号随长文本收缩。
- 未向运行环境安装字体。渲染时使用临时 Fontconfig 配置，把现有 `/System/Library/Fonts`、`/System/Library/Fonts/Supplemental`、`/Library/Fonts` 加入检索，并将缓存放在临时目录。运行时缺省 Fontconfig 未读取这些中文字体，曾出现正文缺字；本记录已用完整系统字体复验。
- 本次证明 native VML 页眉水印可由 LibreOffice 解析、输出并逐页重复；未运行桌面 Microsoft Word，字体回退及各宿主的逐像素排版差异仍由宿主决定。

复验步骤：通过正式导出门面生成 DOCX，给 `FONTCONFIG_FILE` 指定包含上述字体目录的临时配置，执行 `soffice --headless --convert-to pdf --outdir <临时目录> <DOCX>`，再以 `pdftoppm -png -scale-to 1000 <PDF> <图片前缀>` 渲染页面。
