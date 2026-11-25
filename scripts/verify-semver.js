// scripts/verify-semver.js
// 直接引入 lib/semver 与 lib/validators 模块验证语义版本比较与输入安全校验
// 用法：node scripts/verify-semver.js，全部 PASS 退出码 0，否则 1
const {
  extractVersionNumber,
  extractVersionLine,
  parseSemver,
  comparePrerelease,
  compareSemver
} = require('../lib/semver');
const {
  isValidRegistryUrl,
  isValidNpmPackage,
  isValidCliCommand,
  isValidVersionArg
} = require('../lib/validators');

const fns = {
  extractVersionNumber,
  extractVersionLine,
  parseSemver,
  comparePrerelease,
  compareSemver,
  isValidRegistryUrl,
  isValidNpmPackage,
  isValidCliCommand,
  isValidVersionArg
};

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

// 多行输出版本提取：跳过首行 Warning / AutoRun 杂音，定位真正的版本行
const lineCases = [
  [['(node:1234) ExperimentalWarning: foo\n2.1.201 (Claude Code)\n', ''], '2.1.201 (Claude Code)'],
  [['\n\n', 'cli version 1.4.2\n'], 'cli version 1.4.2'],
  [['custom-build-nonsemver\nsecond-line', ''], 'custom-build-nonsemver'],
];
for (const [[stdout, stderr], expected] of lineCases) {
  const got = fns.extractVersionLine(stdout, stderr);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} extractVersionLine() = ${JSON.stringify(got)} (期望 ${JSON.stringify(expected)})`);
}

// 输入校验函数：这些值会拼进子进程参数，必须拒绝空格和特殊字符
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
