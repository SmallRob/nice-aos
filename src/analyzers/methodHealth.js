// =============================================================================
// methodHealth —— 方法级代码健康度分析（借鉴 asdm-aos 的 complexity / isTest /
// endpointInfo / lambdaCount 四大能力，整合为统一的 Method.health 画像）
// -----------------------------------------------------------------------------
// 借鉴要点（asdm-aos 0.0.10, src/server/analyzers/javaAnalyzer.ts）：
//   1. 圈复杂度 calculateComplexity  —— 整合为 complexity.cyclomatic/branches/nesting/throws
//   2. Javadoc 提取                  —— nice-aos 已有 description，整合为 complexity 旁的元信息
//   3. 测试方法 detectTestMethod      —— 升级为 testInfo（isTest/testType/framework/mock）
//   4. API 端点 endpointInfo         —— nice-aos 走 Route 体系，独立处理
//   5. Lambda 计数 lambdaCount        —— 升级为 lambdas(count/maxNesting/inJsx)
//
// 优化点（不是机械照搬，而是 nice-aos 域适配）：
//   - 整合为单一 health 子对象，避免 aos 的 4-5 个零散顶层字段
//   - 前端特有指标：await 链(inJsx lambda, awaits)—— aos 不存在
//   - 派生 risk 评级（low/medium/high/critical），蓝图 viewer 可直接着色
//   - ts/python/rust 各自传 (ts, node, sourceFile)，共享同一分析逻辑
//
// 调用方：
//   - tsAnalyzer.js: 3 个方法 push 点（class/interface/module）调用
//   - pythonAnalyzer / rustAnalyzer: 未来可复用（接口兼容）
// =============================================================================

/**
 * 分析方法的代码健康度，返回 Method.health 子对象。
 *
 * @param {Object} ctx
 * @param {Object} ctx.ts           - TypeScript Compiler API 实例（用于 ts.isXxx 判断）
 * @param {Object} ctx.node         - 方法的 AST 节点（MethodDeclaration / FunctionDeclaration / ArrowFunction / FunctionExpression）
 * @param {Object} ctx.sourceFile   - TS SourceFile（用于 getStart/getText）
 * @param {Object} [ctx.options]    - 可选配置：{ ownerName?, filePath?, language? }
 * @returns {Object} Method.health  - 见 schema
 */
export function analyzeMethodHealth({ ts, node, sourceFile, options = {} }) {
  // interface method signature 没有 body：返回 available:false 的占位
  if (!node || !ts) {
    return placeholderHealth();
  }

  const hasBody = node.body && ts.isBlock(node.body);
  if (!hasBody) {
    // abstract 方法 / interface signature / expression body（如 () => x）
    return {
      ...placeholderHealth(),
      available: false,
      reason: node.body ? 'expression-body' : 'no-body',
    };
  }

  // 复用同一遍遍历：复杂度 + lambda + 测试调用 一并收集
  // parentStack: 维护祖先生长链（不含自身），用于精确判断 inJsx / isLastStatement
  const state = {
    cyclomatic: 1, // 基础复杂度（路径数从 1 起算）
    branches: 0,
    maxNesting: 0,
    throws: 0,
    awaits: 0,
    earlyReturns: 0,
    lastReturnSeen: false, // 跟踪最后访问的 return 节点
    lambdas: { count: 0, maxNesting: 0, inJsx: 0 },
    testInfo: { isTest: false, testType: null, testFramework: null, callsExpect: 0, usesMock: false, frameworkHint: null },
    parentStack: [],
  };
  // 父上下文标记（来自 tsAnalyzer 的 test callback 识别）：如果是 vitest `it('xxx', fn)` 的 fn ，
  // 函数体本身没出现 it 调用，但它是 it 的第二个参数——由调用方在 options.enclosingCallName 告知
  if (options.enclosingCallName) {
    const c = options.enclosingCallName;
    if (c === 'it' || c === 'test' || c === 'specify') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'unit';
    } else if (c === 'describe' || c === 'suite' || c === 'context') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'suite';
    } else if (c === 'beforeAll' || c === 'beforeEach' || c === 'afterAll' || c === 'afterEach') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'setup';
    }
  }
  // 单遍遍历：复杂度 + lambda + 测试调用 + parentStack 一并收集
  walkBody(ts, node.body, state, 0);
  // walkBody 完成后,精确判定 earlyReturns（仅看方法体顶层 statements,不考虑嵌套 return）
  // 注:嵌套块的 return（如 try-catch / if-else 内）不计入 earlyReturn,本指标只针对"方法直接 return 提前退出"
  deriveEarlyReturnCount(ts, node.body, state);

  // 派生 risk 评级
  const risk = deriveRisk(state);

  return {
    available: true,
    complexity: {
      cyclomatic: state.cyclomatic,
      branches: state.branches,
      maxNesting: state.maxNesting,
      throws: state.throws,
      awaits: state.awaits,
      earlyReturns: state.earlyReturns,
    },
    lambdas: state.lambdas,
    testInfo: state.testInfo,
    risk,
  };
}

/** 占位 health（interface signature / 解析失败时用） */
export function placeholderHealth() {
  return {
    available: false,
    reason: null,
    complexity: {
      cyclomatic: null,
      branches: null,
      maxNesting: null,
      throws: null,
      awaits: null,
      earlyReturns: null,
    },
    lambdas: { count: null, maxNesting: null, inJsx: null },
    testInfo: {
      isTest: false,
      testType: null,
      testFramework: null,
      callsExpect: 0,
      usesMock: false,
    },
    risk: 'unknown',
  };
}

// -----------------------------------------------------------------------------
// 内部：单遍 AST 遍历
// -----------------------------------------------------------------------------

/**
 * 递归遍历方法体，累加所有指标。
 * @param {Object} ts - TypeScript Compiler API
 * @param {Object} node - 当前节点
 * @param {Object} state - 累加器
 * @param {number} depth - 当前嵌套深度（块语句内 +1）
 */
function walkBody(ts, node, state, depth) {
  if (!node) return;
  if (depth > state.maxNesting) state.maxNesting = depth;

  // 提前 return：if (...) return; / return x;
  if (ts.isReturnStatement(node)) {
    state.lastReturnSeen = true; // 标记本次遍历最后访问的 return
    // earlyReturn 计数:真正的判定推迟到 walkBody 结束(见 finishEarlyReturnCount)
  }

  // throw 语句
  if (ts.isThrowStatement(node)) {
    state.throws += 1;
  }

  // await 表达式（仅 async 函数体内才有意义，但语法允许——一并统计）
  if (ts.isAwaitExpression(node)) {
    state.awaits += 1;
  }

  // 分支：if / switch / 三元 / 逻辑短路
  if (ts.isIfStatement(node)) {
    state.branches += 1;
    state.cyclomatic += 1;
  } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    state.branches += 1;
    state.cyclomatic += 1;
  } else if (ts.isConditionalExpression(node)) {
    state.branches += 1;
    state.cyclomatic += 1;
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
        || op === ts.SyntaxKind.QuestionQuestionToken) {
      state.branches += 1;
      state.cyclomatic += 1;
    }
  }

  // 循环：for / while / do-while（每个 +1 复杂度 +1 分支）
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    state.branches += 1;
    state.cyclomatic += 1;
  }

  // Lambda：箭头函数 / 函数表达式
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    state.lambdas.count += 1;
    if (depth > state.lambdas.maxNesting) state.lambdas.maxNesting = depth;
    // 是否在 JSX 属性中（直接父是 JsxAttribute 的内联回调，如 onClick={() => ...}）
    if (isJsxAttributeChild(state.parentStack)) {
      state.lambdas.inJsx += 1;
    }
  }

  // 测试方法识别：直接子节点包含 describe/it/test/beforetest 等调用
  detectTestSignature(ts, node, state);

  // 块语句：嵌套深度 +1 后递归
  const incrementDepth =
    ts.isBlock(node)
    || ts.isIfStatement(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node)
    || ts.isTryStatement(node) || ts.isCatchClause(node);

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // Lambda 内部是新的函数作用域，不增加父块深度
    if (node.body && ts.isBlock(node.body)) {
      // push → 递归 → pop
      state.parentStack.push(node);
      walkBody(ts, node.body, state, depth);
      state.parentStack.pop();
    }
  } else {
    state.parentStack.push(node);
    ts.forEachChild(node, (child) => {
      walkBody(ts, child, state, incrementDepth ? depth + 1 : depth);
    });
    state.parentStack.pop();
  }
}

/** 直接父是否为 JsxExpression（JSX 属性的内联回调链: JsxAttribute → JsxExpression → ArrowFunction） */
function isJsxAttributeChild(parentStack) {
  if (parentStack.length === 0) return false;
  const direct = parentStack[parentStack.length - 1];
  if (!direct?.kind) return false;
  // JsxExpression(295) / JsxAttribute(292) 都算 —— 兼容不同遍历顺序
  return direct.kind === 295 || direct.kind === 292;
}

/**
 * 收尾处理：基于 walkBody 收集的 lastReturnSeen 状态，区分"最后一条 return"与"提前 return"
 * 逻辑：递归过程中遇到任何 return 都把 lastReturnSeen 置 true；收尾时该 flag 表示"已至少见到一个 return"。
 * 精确判定：返回节点是否为方法体（或 try/catch/finally 块）中最末语句需 parent 链 —— 已通过 parentStack 实现。
 * 简化策略：仅靠"是否访问了 return 之后还有别的语句"来区分 —— 实际通过在父 Block 节点处理结束时判断"最后一个子节点是不是 ReturnStatement"实现。
 * 由于本函数对方法级风险评级是次要信号（评级已偏保守），保守做法：
 *   - 如果只有 1 个 return 且无其他语句 → 不是 early return
 *   - 如果有 1 个 return 且后面有其他语句 → early return
 *   - 多个 return → 每个 return 都是 early return
 */
function deriveEarlyReturnCount(ts, bodyNode, state) {
  if (!bodyNode || !ts.isBlock(bodyNode)) return;
  const stmts = bodyNode.statements;
  if (!stmts || stmts.length === 0) return;
  // 找所有 return 节点位置
  const returnCount = stmts.filter((s) => ts.isReturnStatement(s)).length;
  if (returnCount === 0) return;
  if (returnCount > 1) {
    // 多个 return：除最后一个外都算 early return
    state.earlyReturns = returnCount - 1;
    return;
  }
  // 单个 return：仅当它不是最后一条语句时算 early return
  const lastStmt = stmts[stmts.length - 1];
  if (!ts.isReturnStatement(lastStmt)) {
    state.earlyReturns = 1;
  }
}

/**
 * 检测方法体是否包含测试调用（vitest / jest / mocha）。
 * 实现：扫描方法体内的 CallExpression，匹配框架 API。
 */
function detectTestSignature(ts, node, state) {
  if (!ts.isCallExpression(node)) return;
  const expr = node.expression;
  if (!expr) return;

  // 形式 1: describe(...) / it(...) / test(...) / expect(...) — 顶层调用
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (name === 'describe' || name === 'suite' || name === 'context') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'suite';
    } else if (name === 'it' || name === 'test' || name === 'specify') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'unit';
    } else if (name === 'beforeAll' || name === 'beforeEach' || name === 'afterAll' || name === 'afterEach') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.testType = 'setup';
    } else if (name === 'expect' || name === 'assert') {
      state.testInfo.isTest = true;
      state.testInfo.testFramework ??= inferTestFramework(state);
      state.testInfo.callsExpect += 1;
    }
  }

  // 形式 2: vi.mock(...) / jest.mock(...) / vi.fn(...) / jest.fn(...) — mock
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const obj = expr.expression.text;
    const method = expr.name.text;
    if ((obj === 'vi' || obj === 'jest' || obj === 'sinon') && method === 'mock') {
      state.testInfo.usesMock = true;
    }
    if ((obj === 'vi' || obj === 'jest') && (method === 'fn' || method === 'spyOn')) {
      state.testInfo.usesMock = true;
    }
    // 记录框架来源信号(基于 mock 工具对象名)+ 直接落地 testFramework
    // 注意:不能仅 inferTestFramework 推断 —— 它要在 detectTestSignature 之外统一调用,这里就近设置
    if (obj === 'vi') {
      state.testInfo.frameworkHint = 'vitest';
      state.testInfo.testFramework ??= 'vitest';
    } else if (obj === 'jest') {
      state.testInfo.frameworkHint = 'jest';
      state.testInfo.testFramework ??= 'jest';
    }
  }
}

/**
 * 从 state.testInfo.frameworkHint 推断测试框架。
 * 优先 vi/jest mock 工具对象名（具体信号），无信号时尝试 it/test 风格判定，否则保持 null。
 * @returns {'vitest' | 'jest' | 'mocha' | 'node' | null}
 */
function inferTestFramework(state) {
  const hint = state.testInfo.frameworkHint;
  if (hint) return hint;
  // 无显式 mock 工具时,不强行猜(避免把 jest 用户误标 vitest)
  return null;
}

// -----------------------------------------------------------------------------
// 风险评级（派生指标）
// -----------------------------------------------------------------------------

/**
 * 派生方法风险等级。
 * 规则（借鉴 aos 思想 + 前端特性调整）：
 *   critical: 圈复杂度 ≥ 20 或 await 链 ≥ 8
 *   high:     圈复杂度 ≥ 10 或 (maxNesting ≥ 4 && lambdas.count ≥ 3)
 *   medium:   圈复杂度 ≥ 5 或 lambdas.count ≥ 3 或 awaits ≥ 3
 *   low:      其他
 */
function deriveRisk(state) {
  const c = state.cyclomatic;
  const l = state.lambdas.count;
  const a = state.awaits;
  const n = state.maxNesting;

  if (c >= 20 || a >= 8) return 'critical';
  if (c >= 10 || (n >= 4 && l >= 3)) return 'high';
  if (c >= 5 || l >= 3 || a >= 3) return 'medium';
  return 'low';
}
