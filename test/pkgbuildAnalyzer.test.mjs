// PKGBUILD analyzer 单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePkgbuild, isPkgbuildCandidate } from '../src/analyzers/pkgbuildAnalyzer.js';

const PKGBUILD_OK = `# Maintainer: SteamClientHomebrew <noreply@steambrew.app>

pkgname="millennium"
pkgver=3.4.0
pkgrel=1
pkgdesc="Open-source modding framework"
arch=('x86_64')
url="https://github.com/SteamClientHomebrew/Millennium"
license=('MIT')
depends=('steam' 'libxtst' 'libx11')
makedepends=('git' 'bun' 'cmake' 'ninja' 'rust')
source=("millennium-\${pkgver}.tar.gz")
sha256sums=('a1b2c3d4e5f6')

build() {
    cd "\${srcdir}"
    cmake --preset linux-arch-pkgbuild
    cmake --build build
}

package() {
    cd "\${srcdir}"
    install -d "\${pkgdir}/usr/lib/millennium"
    install -m755 build/libmillennium_x86.so "\${pkgdir}/usr/lib/millennium/"
}
`;

const PKGBUILD_RISKY = `pkgname="x"
pkgver=1.0
pkgrel=1
pkgdesc="risky"
arch=('x86_64')
license=('MIT')
depends=('steam')
source=("https://github.com/example/foo.tar.gz")
sha256sums=('SKIP')

build() {
    cd "\${srcdir}"
    make
}

package() {
    pkgdir="/"
    sudo cp -r "\${srcdir}"/* "\${pkgdir}"
    rm -rf "\${srcdir}"
}
`;

test('PKGBUILD 候选检测', () => {
  assert.equal(isPkgbuildCandidate('/a/PKGBUILD'), true);
  assert.equal(isPkgbuildCandidate('/a/x.txt'), false);
  assert.equal(isPkgbuildCandidate('/a/pkgbuild'), false, '大小写敏感');
});

test('正常 PKGBUILD: 字段 / 函数 / 风险低', () => {
  const f = analyzePkgbuild('PKGBUILD', PKGBUILD_OK);
  assert.equal(f.isPkgbuild, true);
  assert.equal(f.pkgname, 'millennium');
  assert.equal(f.pkgver, '3.4.0');
  assert.equal(f.pkgrel, '1');
  assert.equal(f.url, 'https://github.com/SteamClientHomebrew/Millennium');
  assert.deepEqual(f.arch, ['x86_64']);
  assert.deepEqual(f.license, ['MIT']);
  assert.ok(f.depends.includes('steam'));
  assert.ok(f.makedepends.includes('rust'));
  assert.equal(f.functionCount, 2, 'build() + package()');
  const fnNames = f.functions.map((fn) => fn.name);
  assert.ok(fnNames.includes('build'));
  assert.ok(fnNames.includes('package'));
  assert.equal(f.sourceIsRemote, false, '本地 source 文件名,不是 http');
  assert.equal(f.sha256Skip, false, 'sha256sums 不是 SKIP');
  assert.equal(f.riskLevel, 'none');
});

test('风险 PKGBUILD: SKIP + 远程 source + sudo + pkgdir=/', () => {
  const f = analyzePkgbuild('PKGBUILD', PKGBUILD_RISKY);
  assert.equal(f.sourceIsRemote, true);
  assert.equal(f.sha256Skip, true);
  const riskKinds = f.risks.map((r) => r.kind);
  assert.ok(riskKinds.includes('remote-source-no-checksum'), '远程 source + SKIP 应被检测');
  assert.ok(riskKinds.includes('sudo-in-package'), 'package() 体内 sudo');
  assert.ok(riskKinds.includes('rm-rf-in-package'), 'package() 体内 rm -rf');
  assert.ok(riskKinds.includes('pkgdir-root'), 'pkgdir="/" 应被检测');
  assert.equal(f.riskLevel, 'high');
});

test('pkgdir-root 不因检查规则重叠产生重复条目', () => {
  const DUAL = `pkgname="x"
pkgver=1.0
pkgrel=1
package() {
    $pkgdir="/"
    pkgdir="/"
    install -d "\${pkgdir}/usr"
}
`;
  const f = analyzePkgbuild('PKGBUILD', DUAL);
  const rootRisks = f.risks.filter((r) => r.kind === 'pkgdir-root');
  assert.equal(rootRisks.length, 1, `$pkgdir 与 pkgdir 两种写法应只记一条,实际 ${rootRisks.length}`);
});

test('空 PKGBUILD', () => {
  const f = analyzePkgbuild('PKGBUILD', '# empty\n');
  assert.equal(f.isPkgbuild, true);
  assert.equal(f.functionCount, 0);
  assert.equal(f.riskLevel, 'none');
});
