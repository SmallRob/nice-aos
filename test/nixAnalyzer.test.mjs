// Nix analyzer 单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNix, isNixCandidate } from '../src/analyzers/nixAnalyzer.js';

const FLAKE_NIX = `{
  description = "Nix Build for Millennium";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/567a49d1913ce81ac6e9582e3553dd90a955875f";
    millennium-src = {
      url = "github:SteamClientHomebrew/Millennium/f37f05bdbd4727d873a1ad83ce72d062ef9a0c48";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, millennium-src, ... }: {
    packages.x86_64-linux = let
      pkgs = import nixpkgs { system = "x86_64-linux"; config.allowUnfree = true; };
    in {
      default = packages.millennium-steam;
      millennium = pkgs.callPackage ./millennium.nix { inherit millennium-src; };
      millennium-steam = pkgs.callPackage ./steam.nix { inherit (packages) millennium; };
    };
  };
}
`;

const LIB_NIX = `{
  mkDerivation,
  stdenv,
  cmake,
  ninja,
  pkg-config,
  bun,
  nodejs,
  cacert,
  patchelf,
  rustPlatform,
  cargo,
  rustc,
  millennium-src,
  lib,
  libx11,
  libXi,
  libXtst,
  re2,
  pkgsi686Linux,
  ...
}:
let
  version = "3.4.0-beta.7";
in
stdenv.mkDerivation {
  inherit version;
  src = millennium-src;
  nativeBuildInputs = [ cmake ninja pkg-config ];
  cmakeGenerator = "Ninja";

  buildInputs = [
    libx11
    libXi
    libXtst
    re2
  ];

  buildPhase = ''
    runHook preBuild
    cmake --build .
  '';

  installPhase = ''
    mkdir -p $out/lib
    install -Dm755 libmillennium_hhx64.so $out/lib/
  '';
}
`;

test('Nix 候选检测', () => {
  assert.equal(isNixCandidate('/a/flake.nix'), true);
  assert.equal(isNixCandidate('/a/x.nix'), true);
  assert.equal(isNixCandidate('/a/flake.lock'), false, '锁定文件跳过');
  assert.equal(isNixCandidate('/a/x.txt'), false);
});

test('flake.nix: inputs / packages / 风险', () => {
  const f = analyzeNix('flake.nix', FLAKE_NIX);
  assert.equal(f.isNix, true);
  assert.equal(f.isFlake, true);
  assert.equal(f.description, 'Nix Build for Millennium');
  // inputs
  assert.equal(f.inputCount, 2);
  const nixpkgsInput = f.inputs.find((i) => i.name === 'nixpkgs');
  assert.ok(nixpkgsInput);
  assert.ok(nixpkgsInput.url?.includes('nixos/nixpkgs/567a49d1913ce81ac6e9582e3553dd90a955875f'));
  assert.equal(nixpkgsInput.hasFlakeAttr, false);
  const srcInput = f.inputs.find((i) => i.name === 'millennium-src');
  assert.equal(srcInput.hasFlakeAttr, true);
  // packages
  assert.equal(f.packageCount, 3);
  const pkgNames = f.outputsPackages.map((p) => p.name);
  assert.ok(pkgNames.includes('default'));
  assert.ok(pkgNames.includes('millennium'));
  assert.ok(pkgNames.includes('millennium-steam'));
  // 风险:channel 形式(未固定 commit)被检测
  // 注意:我们 fixture 里 nixpkgs 是固定 commit,不应报
  const riskKinds = f.risks.map((r) => r.kind);
  // 不应包含 fetcher-no-hash(无 fetcher 调用)
  assert.ok(riskKinds.includes('fetcher-no-hash') === false);
});

test('lib nix: 顶层 fetchFromGitHub 无 hash 风险', () => {
  const FLAKE_BAD = `{
    inputs.foo.url = "github:foo/bar/abc123";
    outputs = { ... }: {
      packages.x86_64-linux.default = derivation {
        src = pkgs.fetchFromGitHub {
          owner = "x";
          repo = "y";
          rev = "abc";
          # 缺 sha256
        };
      };
    };
  }`;
  const f = analyzeNix('flake.nix', FLAKE_BAD);
  const riskKinds = f.risks.map((r) => r.kind);
  assert.ok(riskKinds.includes('fetcher-no-hash'), 'fetchFromGitHub 缺 sha256 应被检测');
});

test('lib nix: buildInputs 抽取', () => {
  const f = analyzeNix('millennium.nix', LIB_NIX);
  assert.equal(f.isFlake, false);
  // buildInputs 列表中应包含 libx11 / libXi / libXtst / re2
  assert.ok(f.buildInputs.buildInputs.includes('libx11'));
  assert.ok(f.buildInputs.buildInputs.includes('libXi'));
  assert.ok(f.buildInputs.buildInputs.includes('libXtst'));
  assert.ok(f.buildInputs.buildInputs.includes('re2'));
  // nativeBuildInputs 不在此 lib
  // 风险低或无
  assert.equal(f.riskLevel === 'none' || f.riskLevel === 'low', true);
});

test('flake.nix 扁平 inputs 写法（inputs.<name>.url = ...）', () => {
  const FLAT = `{
    description = "flat inputs";
    inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    inputs.foo.url = "github:foo/bar";
    inputs.foo.flake = false;
    outputs = { self, nixpkgs, foo }: {
      packages.x86_64-linux.default = nixpkgs.hello;
    };
  }`;
  const f = analyzeNix('flake.nix', FLAT);
  assert.equal(f.inputCount, 2, '扁平写法 inputs.<name>.<key> 应与嵌套写法等价');
  const nixpkgs = f.inputs.find((i) => i.name === 'nixpkgs');
  assert.ok(nixpkgs?.url?.includes('nixos-24.05'));
  const foo = f.inputs.find((i) => i.name === 'foo');
  assert.equal(foo.hasFlakeAttr, true, 'inputs.foo.flake = false 应置 hasFlakeAttr');
});

test('空 nix', () => {
  const f = analyzeNix('x.nix', '{ }');
  assert.equal(f.isNix, true);
  assert.equal(f.inputCount, 0);
  assert.equal(f.packageCount, 0);
});
