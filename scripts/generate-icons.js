// scripts/generate-icons.js
// 将 icon.svg 转换为 electron-builder 所需的 build/icon.png 和 build/icon.ico
// 依赖：sharp（SVG → PNG）、png-to-ico（PNG → ICO）
//
// 注意：NSIS 3.0.4.1（electron-builder 内置）要求 ICO 内嵌尺寸 ≤256，
// 超过 256 会报 "invalid icon file size"。所以 ICO 只放 ≤256 的尺寸，
// 512 单独保留在 PNG 中。

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;

const ROOT = path.dirname(path.dirname(__filename));
const SVG_PATH = path.join(ROOT, "icon.svg");
const OUT_DIR = path.join(ROOT, "build");

// ICO 内嵌尺寸（NSIS 要求 ≤256，必须包含 32x32）
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
// 单独输出的 PNG 大尺寸
const PNG_SIZE = 512;

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`找不到 SVG 源文件: ${SVG_PATH}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const svgBuffer = fs.readFileSync(SVG_PATH);
  console.log(`读取 SVG: ${SVG_PATH} (${svgBuffer.length} bytes)`);

  // 渲染 ICO 所需的各尺寸 PNG
  const pngBuffers = [];
  for (const size of ICO_SIZES) {
    const png = await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size, buffer: png });
    console.log(`  PNG ${size}x${size}: ${png.length} bytes`);
  }

  // 写入大尺寸 PNG（electron-builder 也会用到）
  const png512 = await sharp(svgBuffer, { density: 384 })
    .resize(PNG_SIZE, PNG_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pngPath = path.join(OUT_DIR, "icon.png");
  fs.writeFileSync(pngPath, png512);
  console.log(`写入 ${pngPath} (${PNG_SIZE}x${PNG_SIZE}, ${png512.length} bytes)`);

  // 生成多尺寸 ICO（仅 ≤256）
  const icoBuffer = await pngToIco(pngBuffers.map((p) => p.buffer));
  const icoPath = path.join(OUT_DIR, "icon.ico");
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`写入 ${icoPath} (${icoBuffer.length} bytes, 尺寸: ${ICO_SIZES.join("/")})`);

  console.log("完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
