// CMake analyzer 单元测试：CMakeLists.txt 与 .cmake 模块
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeCMake, isCMakeCandidate } from '../src/analyzers/cmakeAnalyzer.js';

const CMAKE_LISTS = `cmake_minimum_required(VERSION 3.21)
project(MillenniumBuildSlave LANGUAGES CXX)

set(MILLENNIUM_BASE \${CMAKE_SOURCE_DIR})

if(WIN32)
    set(MILLENNIUM_OUTPUT_NAME "millennium.dll")
elseif(APPLE)
    set(MILLENNIUM_OUTPUT_NAME "libmillennium.dylib")
else()
    set(MILLENNIUM_OUTPUT_NAME "libmillennium_x86.so")
endif()

option(MILLENNIUM_BUILD_MAIN "Build main library" ON)
option(MILLENNIUM_BUILD_TESTS "Build tests" ON)
option(MILLENNIUM_NIX_64BIT "Build only 64-bit Nix targets" OFF)

add_executable(millennium-bootstrap src/bootstrap.cc)
add_library(millennium SHARED src/core.cc)
add_library(millennium-static STATIC src/core.cc)
add_custom_target(docs COMMAND doxygen)

target_link_libraries(millennium PRIVATE zlib::zlib)
target_link_libraries(millennium-bootstrap PUBLIC lua::lua)
add_dependencies(millennium millennium-bootstrap)
target_include_directories(millennium PUBLIC include)

add_subdirectory(src)
add_subdirectory(tests)

function(millennium_setup_target target_name)
    target_compile_features(\${target_name} PRIVATE cxx_std_20)
    target_include_directories(\${target_name} PRIVATE \${MILLENNIUM_BASE})
endfunction()

millennium_setup_target(millennium)

include(FetchContent)
FetchContent_Declare(
    zlib
    URL "https://github.com/example/zlib-1.2.13.tar.gz"
    URL_HASH SHA256=abc123
)
FetchContent_MakeAvailable(zlib)

find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
`;

const CMAKE_MODULE = `# Platform / Steam path detection
function(find_steam_path project_name)
    if(WIN32 AND MILLENNIUM_BUILD_TO_STEAM_PATH)
        execute_process(COMMAND reg query "HKCU:\\Software\\Valve\\Steam" /v "SteamPath"
            RESULT_VARIABLE result
            OUTPUT_VARIABLE steam_path)
        if(result EQUAL 0)
            set_target_properties(\${project_name} PROPERTIES
                RUNTIME_OUTPUT_DIRECTORY "\${out_steam_path}/millennium/bin")
        endif()
    endif()
endfunction()
`;

test('CMake 候选检测', () => {
  assert.equal(isCMakeCandidate('/a/CMakeLists.txt'), true);
  assert.equal(isCMakeCandidate('/a/typescript_build.cmake'), true);
  assert.equal(isCMakeCandidate('/a/x.txt'), false);
  assert.equal(isCMakeCandidate('/a/x.sh'), false);
});

test('CMakeLists.txt: targets / options / functions / subdir / fetchContent / 包', () => {
  const f = analyzeCMake('CMakeLists.txt', CMAKE_LISTS);
  assert.equal(f.isCMake, true);
  assert.equal(f.isCMakeLists, true);
  assert.equal(f.isCMakeModule, false);
  // targets
  const targetNames = f.targets.map((t) => t.name);
  assert.ok(targetNames.includes('millennium-bootstrap'));
  assert.ok(targetNames.includes('millennium'));
  assert.ok(targetNames.includes('docs'));
  const millennium = f.targets.find((t) => t.name === 'millennium');
  assert.equal(millennium.kind, 'SHARED');
  const staticOne = f.targets.find((t) => t.name === 'millennium-static');
  assert.equal(staticOne.kind, 'STATIC');
  // options
  const optionNames = f.options.map((o) => o.name);
  assert.ok(optionNames.includes('MILLENNIUM_BUILD_MAIN'));
  assert.ok(optionNames.includes('MILLENNIUM_BUILD_TESTS'));
  assert.ok(optionNames.includes('MILLENNIUM_NIX_64BIT'));
  // functions
  const fnNames = f.functions.map((fn) => fn.name);
  assert.ok(fnNames.includes('millennium_setup_target'));
  // subdirectories
  const subdirs = f.subdirectories.map((s) => s.dir);
  assert.ok(subdirs.includes('src'));
  assert.ok(subdirs.includes('tests'));
  // fetchContent
  assert.equal(f.fetchContentCount, 1);
  const fc = f.fetchContent[0];
  assert.equal(fc.name, 'zlib');
  assert.ok(fc.url?.includes('zlib-1.2.13.tar.gz'));
  // packages
  const pkgNames = f.packages.map((p) => p.name);
  assert.ok(pkgNames.includes('CURL'));
  assert.ok(pkgNames.includes('OpenSSL'));
  assert.equal(f.packages.find((p) => p.name === 'CURL').required, true);
  // 风险:有 URL_HASH 不应报 fetch-no-hash
  const riskKinds = f.risks.map((r) => r.kind);
  assert.ok(riskKinds.includes('fetch-no-hash') === false, 'URL_HASH 已设置,不应报 fetch-no-hash');
});

test('CMake module (.cmake): function / reg 检测', () => {
  const f = analyzeCMake('find_steam_path.cmake', CMAKE_MODULE);
  assert.equal(f.isCMake, true);
  assert.equal(f.isCMakeModule, true);
  assert.equal(f.isCMakeLists, false);
  assert.equal(f.functionCount, 1);
  const fn = f.functions[0];
  assert.equal(fn.name, 'find_steam_path');
  const kinds = f.risks.map((r) => r.kind);
  assert.ok(kinds.includes('registry-read'), 'reg query HKCU\\Software\\Valve\\Steam 应被检测');
  assert.ok(kinds.includes('steam-dir-write'), 'set_target_properties 写入 Steam 路径应被检测');
});

test('CMake 函数间调用边 + option 无引号默认值', () => {
  const SRC = `cmake_minimum_required(VERSION 3.20)
option(USE_SYSTEM_ZLIB ON)
option(BUILD_DOC "Build documentation" OFF)
option(BARE)
function(helper)
    message(STATUS "helper")
endfunction()
function(entry_main)
    helper()
    helper()
endfunction()
entry_main()
`;
  const f = analyzeCMake('CMakeLists.txt', SRC);
  // option 无引号布尔默认值不再被误作 description
  const bare = f.options.find((o) => o.name === 'USE_SYSTEM_ZLIB');
  assert.equal(bare.description, null);
  assert.equal(bare.default, 'ON');
  const doc = f.options.find((o) => o.name === 'BUILD_DOC');
  assert.equal(doc.description, 'Build documentation');
  assert.equal(doc.default, 'OFF');
  const noDefault = f.options.find((o) => o.name === 'BARE');
  assert.equal(noDefault.description, null);
  assert.equal(noDefault.default, null);
  // 函数间调用边：entry_main → helper（重复调用去重为一条）；顶层 entry_main() 不属于任何函数体,不产生边
  assert.deepEqual(f.callEdges, [{ from: 'entry_main', to: ['helper'] }]);
});

test('空 CMakeLists', () => {
  const f = analyzeCMake('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.10)\n');
  assert.equal(f.isCMake, true);
  assert.equal(f.targetCount, 0);
  assert.equal(f.functionCount, 0);
  assert.equal(f.optionCount, 0);
  assert.equal(f.riskLevel, 'none');
});
