// scripts/generate-icons.js
// 将 icon.svg 转换为 electron-builder 所需的图标格式：
// - build/icon.png  (通用，512x512)
// - build/icon.ico  (Windows，多尺寸)
// - build/icon.icns (macOS，多尺寸)
//
// 依赖：sharp（SVG → PNG）、png-to-ico（PNG → ICO）、@fiahfy/icns（PNG → ICNS）
//
// 注意：NSIS 3.0.4.1（electron-builder 内置）要求 ICO 内嵌尺寸 ≤256，
// 超过 256 会报 "invalid icon file size"。所以 ICO 只放 ≤256 的尺寸，
// 512 单独保留在 PNG 中。

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;
const { Icns, IcnsImage } = require("@fiahfy/icns");

const ROOT = path.dirname(path.dirname(__filename));
const SVG_PATH = path.join(ROOT, "icon.svg");
const OUT_DIR = path.join(ROOT, "build");

// ICO 内嵌尺寸（NSIS 要求 ≤256，必须包含 32x32）
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
// 单独输出的 PNG 大尺寸
const PNG_SIZE = 512;
// ICNS 内嵌尺寸（macOS 标准，使用 PNG 格式）
const ICNS_SIZES = [
  { size: 16, osType: "icp4" },
  { size: 32, osType: "icp5" },
  { size: 64, osType: "icp6" },
  { size: 128, osType: "ic07" },
  { size: 256, osType: "ic08" },
  { size: 512, osType: "ic09" },
  { size: 1024, osType: "ic10" },
];

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`找不到 SVG 源文件: ${SVG_PATH}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const svgBuffer = fs.readFileSync(SVG_PATH);
  console.log(`读取 SVG: ${SVG_PATH} (${svgBuffer.length} bytes)`);

  // ========== 生成 ICO 所需的各尺寸 PNG ==========
  const pngBuffers = [];
  for (const size of ICO_SIZES) {
    const png = await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size, buffer: png });
    console.log(`  PNG ${size}x${size}: ${png.length} bytes`);
  }

  // ========== 写入大尺寸 PNG ==========
  const png512 = await sharp(svgBuffer, { density: 384 })
    .resize(PNG_SIZE, PNG_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pngPath = path.join(OUT_DIR, "icon.png");
  fs.writeFileSync(pngPath, png512);
  console.log(`写入 ${pngPath} (${PNG_SIZE}x${PNG_SIZE}, ${png512.length} bytes)`);

  // ========== 生成多尺寸 ICO ==========
  const icoBuffer = await pngToIco(pngBuffers.map((p) => p.buffer));
  const icoPath = path.join(OUT_DIR, "icon.ico");
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`写入 ${icoPath} (${icoBuffer.length} bytes, 尺寸: ${ICO_SIZES.join("/")})`);

  // ========== 生成多尺寸 ICNS ==========
  const icns = new Icns();
  for (const { size, osType } of ICNS_SIZES) {
    const png = await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const image = IcnsImage.fromPNG(png, osType);
    icns.append(image);
    console.log(`  ICNS ${osType} ${size}x${size}: ${png.length} bytes`);
  }
  const icnsPath = path.join(OUT_DIR, "icon.icns");
  fs.writeFileSync(icnsPath, icns.data);
  console.log(`写入 ${icnsPath} (${icns.data.length} bytes, 尺寸: ${ICNS_SIZES.map(s => s.size).join("/")})`);

  console.log("完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
