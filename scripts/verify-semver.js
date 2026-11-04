// scripts/verify-semver.js
// 从 main.js 中提取 semver 相关纯函数并断言比较行为（无测试框架下的轻量验证）
// 用法：node scripts/verify-semver.js，全部 PASS 退出码 0，否则 1
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// 提取顶层函数定义（以 "function name(" 开始、以行首 "}" 结束）
// 注意：仅用于这个无框架的轻量测试，函数格式变化时需要同步调整
const fnNames = [
  'extractVersionNumber', 'parseSemver', 'comparePrerelease', 'compareSemver',
  'isValidRegistryUrl', 'isValidNpmPackage', 'isValidCliCommand', 'isValidVersionArg'
];
const fnSources = [];
for (const name of fnNames) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) {
    console.error(`未找到函数: ${name}`);
    process.exit(1);
  }
  fnSources.push(m[0]);
}
// 把所有函数放进同一个函数作用域，保证 compareSemver 能访问 parseSemver 等依赖
const fns = new Function(
  `${fnSources.join('\n')}\nreturn { ${fnNames.map(n => `${n}: ${n}`).join(', ')} };`
)();

const cases = [
  ['1.2.3', '1.2.4', -1],
  ['1.2.4', '1.2.3', 1],
  ['1.2.3', '1.2.3', 0],
  ['v1.2.3', '1.2.3', 0],
  ['2.0.0-rc.1', '2.0.0', -1],          // 预发布 < 正式版
  ['2.0.0', '2.0.0-rc.1', 1],
  ['2.0.0-rc.1', '2.0.0-rc.2', -1],     // 数字段数值比较
  ['2.0.0-alpha', '2.0.0-alpha.1', -1], // 段数少者更小
  ['2.0.0-alpha.1', '2.0.0-alpha.beta', -1], // 数字段 < 字母段
  ['1.0.0+build.1', '1.0.0', 0],        // 构建元数据忽略
  ['2.1.201 (Claude Code)', '2.1.202', -1], // 含杂质的版本输出
  ['1.3.0-R999.1', '1.3.0-R3401.1', -1],    // Muse 构建号：同前缀字母+数字段按数值比较
  ['1.3.0-R3401.1', '1.3.0-R3401.2', -1],
  ['muse 1.3.0-R3401.1', '1.3.0-R3401.1', 0],
  ['1.2.9-R4000.1', '1.3.0-R3401.1', -1],   // 主版本号优先
];

let failed = 0;
for (const [a, b, expected] of cases) {
  const got = fns.compareSemver(a, b);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} compareSemver(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got} (期望 ${expected})`);
}

// 输入校验函数：这些值会拼进 shell 命令，必须拒绝空格和特殊字符
const validatorCases = [
  ['isValidVersionArg', ['--version'], true],
  ['isValidVersionArg', ['-V'], true],
  ['isValidVersionArg', ['--'], false],
  ['isValidVersionArg', ['--version & calc'], false],
  ['isValidVersionArg', ['--version;rm -rf /'], false],
  ['isValidNpmPackage', ['@scope/name'], true],
  ['isValidNpmPackage', ['name;calc'], false],
  ['isValidCliCommand', ['my-cli'], true],
  ['isValidCliCommand', ['my cli'], false],
  ['isValidRegistryUrl', ['https://registry.npmjs.org/'], true],
  ['isValidRegistryUrl', ['http://registry.npmjs.org/'], false],
  ['isValidRegistryUrl', ['https://user:pass@registry.npmjs.org/'], false],
  ['isValidRegistryUrl', ['https://registry.npmjs.org/?token=x'], false],
  ['isValidRegistryUrl', ['javascript:alert(1)'], false],
  ['isValidRegistryUrl', ['https://x.test/;calc'], false],
];
for (const [fn, args, expected] of validatorCases) {
  const got = fns[fn](...args);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fn}(${args.map(a => JSON.stringify(a)).join(', ')}) = ${got} (期望 ${expected})`);
}

console.log(failed ? `${failed} 个用例失败` : '全部通过');
process.exit(failed ? 1 : 0);
