// ============================================================
// Pipeline 节点评测 — 每个节点100条真实LLM调用
// 用法: npx tsx .evals/tasks/pipeline-bench.ts <node>
// node: router | plan | agent | phase1 | phase2 | all
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 从 ~/.deepseek-code/config.json 读取 API Key
function loadApiKey(): string {
  try {
    const cfgPath = path.join(os.homedir(), '.deepseek-code', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.apiKey || process.env.DEEPSEEK_API_KEY || '';
    }
  } catch {}
  return process.env.DEEPSEEK_API_KEY || '';
}

const BASE_URL = 'https://api.deepseek.com';
const API_KEY = loadApiKey();
if (!API_KEY) { console.error('需要 DEEPSEEK_API_KEY (环境变量或 ~/.deepseek-code/config.json)'); process.exit(1); }

const RESULTS_DIR = path.join(__dirname, '..', 'bench-results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

interface BenchResult {
  id: string;
  input: string;
  output: string;
  latencyMs: number;
  tokensPrompt: number;
  tokensCompletion: number;
  passed: boolean;
  checks: string[];
}

// ═══ 测试输入 ═══

const ROUTER_INPUTS = [
  // 30 中文日常
  "帮我审查一下当前项目代码", "修复 router.ts 的类型错误", "跑一个hello脚本",
  "解释一下这个项目的架构", "检查 git diff 有没有安全问题", "你好",
  "讲一下 loop.ts 是怎么工作的", "帮我写一个登录页面", "继续",
  "这个文件在哪个目录", "上面的链接内容是什么", "帮我看看这个项目",
  "有哪些地方需要优化", "有没有安全漏洞", "生成一个测试用例",
  "怎么接入这个API", "能不能帮我把这段代码重构一下", "退出",
  "帮我分析一下性能瓶颈", "这个错误怎么修", "查看当前git状态",
  "有没有文档需要更新", "帮我配置一下ESLint", "检查有没有死代码",
  "统计一下这个目录的文件行数", "项目依赖有没有版本冲突",
  "帮我生成 AGENTS.md", "解释 TypeScript 类型体操", "显示帮助",
  "讲一下上面提到的那个bug", "用中文回答",
  // 20 英文
  "Explain the project architecture", "Fix the type error in router.ts",
  "Run a hello script", "Check git diff for security issues", "Hello",
  "How does loop.ts work", "What does this project do", "Continue",
  "Where is this file located", "Help me refactor this code",
  "Check for dead code", "Generate unit tests", "Show git status",
  "Review my code", "Find security vulnerabilities", "Exit",
  "How do I use this API", "What's the performance like",
  "Are there dependency conflicts", "I need help with TypeScript",
  // 20 混合/边界
  "帮我check一下这个bug", "看下diff有什么改动", "executor.ts里面有什么",
  "刚才讲的", "?", "为什么报错了", "你支持哪些功能",
  "怎么用dscode", "分析一下 ./src 目录", "这个怎么修 TS2345",
  "帮我跑 pnpm test", "审查代码质量", "写个readme",
  "这个项目用的是什么技术栈", "帮我找一个文件",
  "那个函数在哪个文件里", "对比一下两个方案", "帮我排查内存泄漏",
  "我需要一个rest api", "给我看git log",
];

const PLAN_INPUTS = [
  // 30 审查/分析
  "审查当前项目代码", "审查 packages/core/src/agent/router.ts",
  "分析项目架构", "检查安全漏洞", "审查代码质量",
  "检查有没有死代码", "审查类型安全", "分析性能瓶颈",
  "审查错误处理", "检查测试覆盖", "审查依赖安全",
  "分析项目结构", "审查配置文件", "检查硬编码密钥",
  "审查交互逻辑", "分析数据流", "审查权限控制",
  "检查日志输出", "审查异常处理", "分析模块耦合",
  "审查API设计", "检查并发安全", "审查内存使用",
  "分析启动流程", "审查插件系统", "检查国际化支持",
  "审查缓存策略", "分析数据库查询", "审查认证逻辑",
  "检查XSS防护", "分析构建配置",
  // 20 修复/开发
  "修复 router.ts 的类型错误", "给 loop.ts 加错误处理",
  "实现一个缓存层", "重构 executor.ts", "写一个工具函数",
  "修复 executors.ts 的内存泄漏", "优化搜索性能",
  "添加日志记录", "修复 autofix-loop.ts 的回滚bug",
  "实现多线程支持", "给 web-search.ts 加重试",
  "修复 deepseek.ts 的超时处理", "优化 prompt 构建速度",
  "添加单元测试", "修复类型定义不一致",
  "实现文件监听功能", "优化KV Cache命中率",
  "修复并发问题", "添加请求限流", "实现优雅关闭",
  // 20 解释/分析
  "解释项目架构", "分析 Router 的工作原理",
  "解释 Agent Loop 的执行流程", "分析 KV Cache 策略",
  "解释权限系统设计", "分析工具注册机制",
  "解释 prompt 构建逻辑", "分析安全防护层",
  "解释会话管理", "分析评测体系",
  "解释错误处理策略", "分析模型路由逻辑",
  "解释状态机设计", "分析 Pipeline 编排",
  "解释 CLI 命令系统", "分析上下文缓存",
  "解释搜索降级策略", "分析 URL 安全校验",
  "解释重试逻辑", "分析熔断机制",
  // 15 跑/执行
  "跑一个hello脚本", "运行 typecheck", "执行 pnpm test",
  "跑一下构建", "运行 lint 检查", "执行数据库迁移",
  "跑一下性能测试", "运行单元测试", "执行部署脚本",
  "跑一下集成测试", "运行代码格式化", "执行清理脚本",
  "跑一下安全扫描", "运行 e2e 测试", "执行备份",
  // 15 英文
  "Review the current project code", "Fix the type error",
  "Explain the architecture", "Run the test suite",
  "Check for security issues", "Add error handling",
  "Implement caching", "Optimize performance",
  "Generate unit tests", "Refactor the router",
  "Analyze dependencies", "Build the project",
  "Run linting", "Deploy the application", "Debug the issue",
];

// ═══ LLM Client ═══

async function fetchLLM(messages: Array<{role:string;content:string}>, opts: {
  model?: string; maxTokens?: number; temperature?: number; stream?: boolean;
} = {}): Promise<any> {
  const body: any = {
    model: opts.model || 'deepseek-v4-pro',
    messages,
    max_tokens: opts.maxTokens || 512,
    temperature: opts.temperature ?? 0.1,
    stream: opts.stream || false,
  };
  if (opts.model === 'deepseek-v4-flash') body.thinking = { type: 'disabled' };
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return res.json();
}

// ═══ Node 1: Router ═══

async function benchRouter(): Promise<BenchResult[]> {
  console.log(`\n🔬 节点1: Router (Flash, 意图分类) — ${ROUTER_INPUTS.length}条\n`);
  const results: BenchResult[] = [];

  for (let i = 0; i < ROUTER_INPUTS.length; i++) {
    const input = ROUTER_INPUTS[i];
    const start = Date.now();
    let raw = '', tokensPrompt = 0, tokensCompletion = 0;
    const checks: string[] = [];

    try {
      const resp = await fetchLLM([
        { role: 'system', content: '你是意图路由器。根据用户输入输出 JSON: {intent, execution, confidence, reason}。intent可选: code_task/debug_task/audit_task/explain_project/small_talk/command_help/command_exit/unknown。execution: agent_readonly/agent_plan/llm_direct/local_action/url_fetch_pipeline。只输出JSON。' },
        { role: 'user', content: input },
      ], { model: 'deepseek-v4-flash', maxTokens: 256 });

      raw = resp.choices?.[0]?.message?.content || '';
      tokensPrompt = resp.usage?.prompt_tokens || 0;
      tokensCompletion = resp.usage?.completion_tokens || 0;

      // 验证 JSON
      try { JSON.parse(raw); checks.push('valid_json'); } catch { checks.push('invalid_json'); }

      // 验证 intent 合法
      const validIntents = ['code_task','debug_task','audit_task','explain_project','small_talk','command_help','command_exit','command_status','webpage_summary','unknown'];
      if (validIntents.some(v => raw.includes(v))) checks.push('valid_intent');
      else checks.push('invalid_intent');

      // 验证 execution 合法
      const validExecs = ['agent_readonly','agent_plan','agent_execute','llm_direct','local_action','url_fetch_pipeline'];
      if (validExecs.some(v => raw.includes(v))) checks.push('valid_execution');
      else checks.push('invalid_execution');

    } catch(e) { checks.push(`error:${e}`); }

    const r: BenchResult = { id: `router_${i}`, input, output: raw.slice(0, 200), latencyMs: Date.now()-start, tokensPrompt, tokensCompletion, passed: checks.includes('valid_json') && checks.includes('valid_intent'), checks };
    results.push(r);
    console.log(`  ${r.passed?'✅':'❌'} ${(i+1).toString().padStart(3)} ${input.slice(0,40).padEnd(42)} ${r.latencyMs}ms ${r.checks.filter(c=>c.includes('invalid')).join(',')}`);
  }
  return results;
}

// ═══ Node 2: Plan ═══

async function benchPlan(): Promise<BenchResult[]> {
  console.log(`\n🔬 节点2: Plan (Flash, 计划生成) — ${PLAN_INPUTS.slice(0,100).length}条\n`);
  const results: BenchResult[] = [];
  const inputs = PLAN_INPUTS.slice(0, 100);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const start = Date.now();
    let raw = '', tokensPrompt = 0, tokensCompletion = 0;
    const checks: string[] = [];

    try {
      const resp = await fetchLLM([
        { role: 'system', content: 'JSON格式: {"steps":[{"order":1,"action":"read","description":"读取package.json","targetFiles":["package.json"]}]}。action: read/search/verify。只输出JSON。步骤3-8个。禁止分析结论。' },
        { role: 'user', content: `需求: ${input}` },
      ], { model: 'deepseek-v4-flash', maxTokens: 512 });

      raw = resp.choices?.[0]?.message?.content || '';
      tokensPrompt = resp.usage?.prompt_tokens || 0;
      tokensCompletion = resp.usage?.completion_tokens || 0;

      // 验证 JSON
      let parsed: any = null;
      try { parsed = JSON.parse(raw); checks.push('valid_json'); } catch { checks.push('invalid_json'); }

      // 验证步骤不为空
      if (parsed?.steps?.length > 0) checks.push('has_steps');
      else checks.push('no_steps');

      // 验证步骤不包含"缺少""不符合"等分析结论
      const hallucinationPatterns = /缺少|不符合|不存在|应该用|建议改为|项目没有|没有配置|没有定义/;
      if (!hallucinationPatterns.test(raw)) checks.push('no_hallucination');
      else checks.push('has_hallucination');

      // 验证步骤描述不是光秃秃的工具名
      const bareName = /"description"\s*:\s*"(read_file|list_files|search_code|glob)"\s*[,}]/;
      if (!bareName.test(raw)) checks.push('descriptive_steps');
      else checks.push('bare_names');

    } catch(e) { checks.push(`error:${e}`); }

    const passed = checks.includes('valid_json') && checks.includes('has_steps') && checks.includes('no_hallucination') && checks.includes('descriptive_steps');
    const r: BenchResult = { id: `plan_${i}`, input, output: raw.slice(0, 200), latencyMs: Date.now()-start, tokensPrompt, tokensCompletion, passed, checks };
    results.push(r);
    console.log(`  ${r.passed?'✅':'❌'} ${(i+1).toString().padStart(3)} ${input.slice(0,40).padEnd(42)} ${r.latencyMs}ms [${r.checks.join(' ')}]`);
  }
  return results;
}

// ═══ Node 3: Agent Loop ═══

const AGENT_INPUTS = PLAN_INPUTS.slice(0, 30);

async function benchAgent(): Promise<BenchResult[]> {
  console.log(`\n🔬 节点3: Agent Loop (Pro, 工具调用+分析) — ${AGENT_INPUTS.length}条\n`);
  const results: BenchResult[] = [];

  for (let i = 0; i < AGENT_INPUTS.length; i++) {
    const input = AGENT_INPUTS[i];
    const start = Date.now();
    let raw = '', tokensPrompt = 0, tokensCompletion = 0;
    const checks: string[] = [];

    try {
      // 模拟 Agent Loop 的一轮调用: 有tools, 有上下文
      const resp = await fetchLLM([
        { role: 'system', content: '你是 DeepSeek Code Agent。根据项目信息和工具结果分析代码。每个发现标注文件:行号和代码证据。' },
        { role: 'user', content: `项目: TypeScript monorepo, packages: shared/core/cli\n\n已读取: package.json(scripts: build/dev/test/lint), tsconfig.base.json, packages/core/src/index.ts(导出:ModelRouter,createToolExecutors,runAgentLoop...)\n\n任务: ${input}\n\n根据以上信息分析，输出3个以内的发现。` },
      ], { model: 'deepseek-v4-pro', maxTokens: 1024, temperature: 0.3 });

      raw = resp.choices?.[0]?.message?.content || '';
      tokensPrompt = resp.usage?.prompt_tokens || 0;
      tokensCompletion = resp.usage?.completion_tokens || 0;

      // 验证有实质性内容
      if (raw.length > 50) checks.push('has_content');
      else checks.push('empty_or_short');

      // 验证没有编造不存在的文件路径
      const fakePaths = raw.match(/[a-zA-Z0-9_/.-]+\.(ts|tsx|js|json)/g) || [];
      const realPaths = ['package.json','tsconfig.base.json','index.ts','router.ts','loop.ts','executors.ts','scanner.ts','prompt-builder.ts','deepseek.ts','types.ts','utils.ts','planner.ts'];
      const hasFake = fakePaths.some((fp: string) => !realPaths.some(rp => fp.includes(rp)));
      if (!hasFake) checks.push('no_fake_paths');
      else checks.push('fake_paths:' + fakePaths.filter((fp: string) => !realPaths.some(rp => fp.includes(rp))).slice(0, 3).join(','));

      // 验证有具体的发现
      if (/发现|问题|风险|建议|优化|漏洞|bug|error|warning/i.test(raw)) checks.push('has_findings');
      else checks.push('no_findings');

    } catch(e) { checks.push(`error:${e}`); }

    const passed = checks.includes('has_content') && checks.includes('no_fake_paths');
    const r: BenchResult = { id: `agent_${i}`, input, output: raw.slice(0, 200), latencyMs: Date.now()-start, tokensPrompt, tokensCompletion, passed, checks };
    results.push(r);
    console.log(`  ${r.passed?'✅':'❌'} ${(i+1).toString().padStart(3)} ${input.slice(0,40).padEnd(42)} ${r.latencyMs}ms ${r.checks.join(' ')}`);
  }
  return results;
}

// ═══ Node 4: Phase1 ═══

const PHASE_INPUTS = PLAN_INPUTS.slice(0, 30);

async function benchPhase1(): Promise<BenchResult[]> {
  console.log(`\n🔬 节点4: Phase1 (Pro, 核心摘要) — ${PHASE_INPUTS.length}条\n`);
  const results: BenchResult[] = [];

  for (let i = 0; i < PHASE_INPUTS.length; i++) {
    const input = PHASE_INPUTS[i];
    const start = Date.now();
    let raw = '', tokensPrompt = 0, tokensCompletion = 0;
    const checks: string[] = [];

    try {
      const resp = await fetchLLM([
        { role: 'system', content: '你是 DeepSeek Code Agent。基于前面的分析，输出1-2句最关键的发现或结论，不超过80字。只输出结论。' },
        { role: 'user', content: `分析任务: ${input}\n\n已分析: 发现executor.ts有3处catch{}静默异常, scanner.ts缓存命中率可优化, web-search.ts的validateUrl正则缺少169.254段。\n\n输出核心发现:` },
      ], { model: 'deepseek-v4-pro', maxTokens: 200, temperature: 0.3 });

      raw = resp.choices?.[0]?.message?.content || '';
      tokensPrompt = resp.usage?.prompt_tokens || 0;
      tokensCompletion = resp.usage?.completion_tokens || 0;

      if (raw.length > 10) checks.push('has_content');
      else checks.push('empty');
      if (raw.length < 200) checks.push('concise');
      else checks.push('too_long');
      if (!/基于|根据|通过/i.test(raw)) checks.push('direct');
      else checks.push('verbose_prefix');

    } catch(e) { checks.push(`error:${e}`); }

    const passed = checks.includes('has_content') && checks.includes('concise');
    const r: BenchResult = { id: `phase1_${i}`, input, output: raw.slice(0, 200), latencyMs: Date.now()-start, tokensPrompt, tokensCompletion, passed, checks };
    results.push(r);
    console.log(`  ${r.passed?'✅':'❌'} ${(i+1).toString().padStart(3)} ${input.slice(0,40).padEnd(42)} ${r.latencyMs}ms [${r.checks.join(' ')}]`);
  }
  return results;
}

// ═══ Node 5: Phase2 ═══

async function benchPhase2(): Promise<BenchResult[]> {
  console.log(`\n🔬 节点5: Phase2 (Pro, 详细报告) — ${PHASE_INPUTS.length}条\n`);
  const results: BenchResult[] = [];

  for (let i = 0; i < PHASE_INPUTS.length; i++) {
    const input = PHASE_INPUTS[i];
    const start = Date.now();
    let raw = '', tokensPrompt = 0, tokensCompletion = 0;
    const checks: string[] = [];

    try {
      const resp = await fetchLLM([
        { role: 'system', content: '你是 DeepSeek Code Agent。输出详细分析报告。每个发现标注文件:行号、代码证据、建议。只说确定的事实。' },
        { role: 'user', content: `任务: ${input}\n\n核心发现: executor.ts有3处catch{}静默异常, scanner.ts指纹缓存混用sync I/O。\n\n输出详细报告:` },
      ], { model: 'deepseek-v4-pro', maxTokens: 1024, temperature: 0.3 });

      raw = resp.choices?.[0]?.message?.content || '';
      tokensPrompt = resp.usage?.prompt_tokens || 0;
      tokensCompletion = resp.usage?.completion_tokens || 0;

      if (raw.length > 100) checks.push('detailed');
      else checks.push('too_short');
      if (/文件:行号|\.ts:\d+|\.ts \d+行|L\d+/i.test(raw)) checks.push('has_locations');
      else checks.push('no_locations');
      if (!/可能|大概|也许|或许|不确定/i.test(raw)) checks.push('definitive');
      else checks.push('speculative');

    } catch(e) { checks.push(`error:${e}`); }

    const passed = checks.includes('detailed') && checks.includes('has_locations');
    const r: BenchResult = { id: `phase2_${i}`, input, output: raw.slice(0, 200), latencyMs: Date.now()-start, tokensPrompt, tokensCompletion, passed, checks };
    results.push(r);
    console.log(`  ${r.passed?'✅':'❌'} ${(i+1).toString().padStart(3)} ${input.slice(0,40).padEnd(42)} ${r.latencyMs}ms [${r.checks.join(' ')}]`);
  }
  return results;
}

// ═══ Main ═══

async function main() {
  const node = process.argv[2] || 'router';
  let results: BenchResult[] = [];

  if (node === 'router' || node === 'all') {
    results = await benchRouter();
    fs.writeFileSync(path.join(RESULTS_DIR, 'router.json'), JSON.stringify(results, null, 2));
    summarize(results, 'Router');
  }
  if (node === 'plan' || node === 'all') {
    results = await benchPlan();
    fs.writeFileSync(path.join(RESULTS_DIR, 'plan.json'), JSON.stringify(results, null, 2));
    summarize(results, 'Plan');
  }
  if (node === 'agent' || node === 'all') {
    results = await benchAgent();
    fs.writeFileSync(path.join(RESULTS_DIR, 'agent.json'), JSON.stringify(results, null, 2));
    summarize(results, 'Agent Loop');
  }
  if (node === 'phase1' || node === 'all') {
    results = await benchPhase1();
    fs.writeFileSync(path.join(RESULTS_DIR, 'phase1.json'), JSON.stringify(results, null, 2));
    summarize(results, 'Phase1');
  }
  if (node === 'phase2' || node === 'all') {
    results = await benchPhase2();
    fs.writeFileSync(path.join(RESULTS_DIR, 'phase2.json'), JSON.stringify(results, null, 2));
    summarize(results, 'Phase2');
  }
}

function summarize(results: BenchResult[], label: string) {
  const passed = results.filter(r => r.passed).length;
  const avgLatency = results.reduce((s,r) => s+r.latencyMs, 0) / results.length;
  const avgTokens = results.reduce((s,r) => s+r.tokensPrompt+r.tokensCompletion, 0) / results.length;
  const p50 = results.sort((a,b) => a.latencyMs-b.latencyMs)[Math.floor(results.length/2)]?.latencyMs || 0;
  console.log(`\n📊 ${label}: ${passed}/${results.length}通过 | 均${avgLatency.toFixed(0)}ms | P50=${p50}ms | 均${avgTokens.toFixed(0)}tokens`);
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log(`❌ 失败(${failures.length}):`);
    for (const f of failures.slice(0,5)) console.log(`   ${f.input.slice(0,50)} → ${f.checks.join(',')}`);
  }
}

main().catch(console.error);
