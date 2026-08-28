// Shell 脚本（PowerShell + Bash）单元测试：元数据块 / 函数 / builtin / cmd / 注册表 / 风险
// 覆盖 shellScriptAnalyzer 公开 API：analyzeShellScript / isShellScriptCandidate / detectShellLanguage / parsePowerShellHelp
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShellScript, isShellScriptCandidate, detectShellLanguage, parsePowerShellHelp } from '../src/analyzers/shellScriptAnalyzer.js';

const BASH_INSTALL = `#!/usr/bin/env bash
# @name install.sh
# @description Linux install helper for Millennium
# @notes One-click installer
# https://github.com/SteamClientHomebrew/Millennium/blob/main/scripts/install.sh

readonly INSTALL_DIR="/tmp/millennium"
DRY_RUN=0
BETA=0

log() { printf "%b\\n" "$1"; }
warn() { printf "\\033[1;33m%b\\033[0m\\n" "$1"; }

verify_platform() {
    case $(uname -sm) in
        "Linux x86_64") echo "linux-x86_64" ;;
        *) log "Unsupported"; exit 1 ;;
    esac
}

check_dependencies() {
    local deps=(curl tar jq sudo)
    for cmd in "\${deps[@]}"; do
        command -v "\${cmd}" >/dev/null || { log "\${cmd} missing"; exit 1; }
    done
}

download_package() {
    local url="$1"
    local dest="$2"
    curl --fail --location --output "\${dest}" "\${url}"
}

verify_checksum() {
    sha256sum -c --status
}

install_millennium() {
    sudo cp -r "\${1}"/* /
    sudo ln -sf /usr/lib/millennium/bootstrap.so /tmp/m
}

post_install() {
    rm -rf $HOME/.millennium
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run)    DRY_RUN=1 ;;
            --beta)       BETA=1 ;;
            --yes)        YES=1 ;;
            --run-id=*)   RUN_ID="\${1#*=}" ;;
        esac
        shift
    done
    verify_platform
    check_dependencies
    download_package "https://github.com/example/release.tar.gz" "/tmp/m.tar.gz"
    verify_checksum
    install_millennium "/tmp/m"
    post_install
}

main "$@"
`;

const POWERSHELL_INSTALL = `<#
.SYNOPSIS
    Millennium - Windows one-click installer.
.DESCRIPTION
    Mirrors scripts/install.sh for Windows. Downloads a signed Millennium release.
.PARAMETER Beta
    Install the latest pre-release instead of the latest stable release.
.PARAMETER RunId
    Install a specific GitHub Actions nightly artifact.
.EXAMPLE
    PS> .\\install.ps1 -Beta
.NOTES
    Requires PowerShell 5.1+.
#>

[CmdletBinding()]
param(
    [switch]$Beta,
    [string]$RunId,
    [string]$SteamPath,
    [switch]$Yes,
    [switch]$Force,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Script:UseAnsi = $true

function Write-Banner { Write-Host 'Millennium' }
function Resolve-SteamPath { Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name 'SteamPath' }
function Test-SteamRunning { Get-Process -Name 'steam' }
function Stop-Steam { Stop-Process -Name 'steam' -Force }
function Get-LatestRelease { Invoke-RestMethod -Uri 'https://api.github.com/repos/x/y/releases' }
function Get-Sha256OfFile { Get-FileHash -Path \$args[0] -Algorithm SHA256 }
function Install-Millennium {
    Get-LatestRelease
    Stop-Steam
    Resolve-SteamPath
    Copy-Item -Path 'src' -Destination 'dst' -Recurse -Force
    Remove-Item -Path 'dst' -Recurse -Force
}

try {
    if (\$Beta -and \$RunId) { throw 'mutually exclusive' }
    Write-Banner
    Install-Millennium
} catch { Write-Error \$_.Exception.Message; exit 1 }
`;

test('Bash 候选检测 + 语言分派', () => {
  assert.equal(isShellScriptCandidate('/a/install.sh'), true);
  assert.equal(isShellScriptCandidate('/a/setup.bash'), true);
  assert.equal(isShellScriptCandidate('/a/x.zsh'), true);
  assert.equal(isShellScriptCandidate('/a/x.ps1'), true);
  assert.equal(isShellScriptCandidate('/a/x.user.js'), false, '油猴脚本优先');
  assert.equal(isShellScriptCandidate('/a/x.ts'), false);
  assert.equal(detectShellLanguage('/a/install.sh'), 'bash');
  assert.equal(detectShellLanguage('/a/x.ps1'), 'powershell');
});

test('Bash: header / 函数 / builtin / CLI 参数 / 风险', () => {
  const f = analyzeShellScript('install.sh', BASH_INSTALL);
  assert.equal(f.isShellScript, true);
  assert.equal(f.shellLanguage, 'bash');
  assert.equal(f.shebang, '#!/usr/bin/env bash');
  assert.equal(f.description?.includes('install helper'), true);
  assert.equal(f.name, 'install.sh');
  // 6 个函数: log / warn / verify_platform / check_dependencies / download_package / verify_checksum / install_millennium / post_install / main
  const fnNames = f.functions.map((fn) => fn.name);
  assert.ok(fnNames.includes('verify_platform'));
  assert.ok(fnNames.includes('check_dependencies'));
  assert.ok(fnNames.includes('install_millennium'));
  assert.ok(fnNames.includes('main'));
  assert.equal(f.hasMainEntry, true, 'main "$@" 入口');
  assert.equal(f.hasTopLevelDispatch, true, '顶层 while + case');

  // CLI 参数 --dry-run --beta --yes --run-id
  const paramNames = f.cliParams.map((p) => p.name);
  assert.ok(paramNames.includes('dry-run'));
  assert.ok(paramNames.includes('beta'));
  assert.ok(paramNames.includes('yes'));
  assert.ok(paramNames.includes('run-id'));

  // builtin 调用
  const builtinNames = f.builtinCalls.map((b) => b.name);
  assert.ok(builtinNames.includes('sudo'), 'sudo 是关键风险命令');
  assert.ok(builtinNames.includes('curl'));
  assert.ok(builtinNames.includes('sha256sum'));
  assert.ok(builtinNames.includes('jq'));

  // 风险检测
  const riskKinds = f.risks.map((r) => r.kind);
  assert.ok(riskKinds.includes('sudo-cp'), 'sudo cp 应被检测');
  assert.ok(riskKinds.includes('download-no-checksum') === false, '有 sha256sum 不应报下载无校验');
  assert.equal(f.riskLevel, 'high', '含 sudo cp 应为 high');

  // 下载 URL
  const urls = f.downloadUrls.map((u) => u.url);
  assert.ok(urls.some((u) => u.includes('github.com/example')));

  // 函数角色
  const main = f.functions.find((fn) => fn.name === 'main');
  assert.equal(main.role, 'entry');
  const installFn = f.functions.find((fn) => fn.name === 'install_millennium');
  assert.equal(installFn.role, 'install');

  // 函数级 builtin / CLI 参数名单（供 builder 生成精确 usesBuiltin / readsCliParam 边）
  assert.deepEqual([...installFn.builtinNames].sort(), ['cp', 'ln', 'sudo'], 'install_millennium 实际调用 sudo/cp/ln');
  assert.deepEqual([...installFn.cliParamNames].sort(), []);
  assert.deepEqual([...main.cliParamNames].sort(), ['beta', 'dry-run', 'run-id', 'yes'], 'main 的 case 分发读到全部 4 个参数');

  // 函数调用图:main → verify_platform / check_dependencies / download_package / verify_checksum / install_millennium / post_install
  const mainCalls = f.callEdges.find((e) => e.from === 'main');
  assert.ok(mainCalls);
  assert.ok(mainCalls.to.includes('verify_platform'));
  assert.ok(mainCalls.to.includes('install_millennium'));
});

test('PowerShell: help / CmdletBinding / param / cmdlet / 注册表 / 风险', () => {
  const f = analyzeShellScript('install.ps1', POWERSHELL_INSTALL);
  assert.equal(f.isShellScript, true);
  assert.equal(f.shellLanguage, 'powershell');
  assert.equal(f.hasCmdletBinding, true);

  // help 块
  assert.equal(f.description?.includes('Mirrors scripts/install.sh for Windows'), true);
  assert.ok(f.examples.length > 0, '.EXAMPLE 段应被抽到 examples[]');

  // param() 解析
  const paramNames = f.cliParams.map((p) => p.name);
  assert.ok(paramNames.includes('Beta'));
  assert.ok(paramNames.includes('RunId'));
  assert.ok(paramNames.includes('SteamPath'));
  const beta = f.cliParams.find((p) => p.name === 'Beta');
  assert.equal(beta.type, 'switch');
  const runId = f.cliParams.find((p) => p.name === 'RunId');
  assert.equal(runId.type, 'string');

  // 函数集合
  const fnNames = f.functions.map((fn) => fn.name);
  assert.ok(fnNames.includes('Write-Banner'));
  assert.ok(fnNames.includes('Resolve-SteamPath'));
  assert.ok(fnNames.includes('Install-Millennium'));

  // cmdlet 抽取
  const cmdletNames = f.cmdletCalls.map((c) => c.name);
  assert.ok(cmdletNames.includes('Get-ItemProperty'));
  assert.ok(cmdletNames.includes('Invoke-RestMethod'));
  assert.ok(cmdletNames.includes('Get-FileHash'));
  assert.ok(cmdletNames.includes('Stop-Process'));
  assert.ok(cmdletNames.includes('Copy-Item'));
  assert.ok(cmdletNames.includes('Remove-Item'));
  // isNet 标记
  const irm = f.cmdletCalls.find((c) => c.name === 'Invoke-RestMethod');
  assert.equal(irm.isNet, true);

  // 函数级 cmdlet 名单（供 builder 生成精确 usesBuiltin 边）
  const installPs = f.functions.find((fn) => fn.name === 'Install-Millennium');
  assert.ok(installPs.cmdletNames.includes('Copy-Item'));
  assert.ok(installPs.cmdletNames.includes('Remove-Item'));
  // 函数级 CLI 参数引用（本 fixture 的函数体不引用任何 param）
  assert.deepEqual([...installPs.cliParamNames], []);

  // 注册表: HKCU:\Software\Valve\Steam
  assert.ok(f.regOps.length > 0, '应抽到注册表操作');
  assert.equal(f.regOps[0].hive, 'HKCU');

  // 下载 URL
  const urls = f.downloadUrls.map((u) => u.url);
  assert.ok(urls.some((u) => u.includes('api.github.com')));

  // 风险:有 Get-FileHash 不报 download-no-checksum
  const kinds = f.risks.map((r) => r.kind);
  assert.ok(kinds.includes('download-no-checksum') === false, '有 Get-FileHash 不应报下载无校验');
  // Remove-Item -Recurse -Force 应当被检测
  assert.ok(kinds.includes('force-recurse-remove'), 'Remove-Item -Recurse -Force 强删应被检测');
  // Stop-Process -Force
  assert.ok(kinds.includes('force-kill'), 'Stop-Process -Force 应被检测');
  assert.equal(f.riskLevel, 'high');

  // 角色推断
  const getFn = f.functions.find((fn) => fn.name === 'Resolve-SteamPath');
  assert.equal(getFn.role, 'resolve', 'Resolve- 前缀应归 resolve 角色');
  const stopFn = f.functions.find((fn) => fn.name === 'Stop-Steam');
  assert.equal(stopFn.role, 'exec');
});

test('parsePowerShellHelp 直接调用', () => {
  const help = parsePowerShellHelp(POWERSHELL_INSTALL);
  assert.ok(help);
  assert.equal(help.synopsis?.includes('Windows one-click installer'), true);
  assert.equal(help.parameters.length >= 2, true, '至少 .PARAMETER Beta + RunId');
});

test('空脚本不应崩溃', () => {
  const f = analyzeShellScript('empty.sh', '#!/bin/bash\n# nothing\n');
  assert.equal(f.isShellScript, true);
  assert.equal(f.fnCount, 0);
  assert.equal(f.builtinCount, 0);
  assert.equal(f.riskLevel, 'none');
});
