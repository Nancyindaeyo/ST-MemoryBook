import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  buildBatchSummaryPrompt,
  buildBatchThinking,
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
  RESUMMARY_THINKING_CHECKLIST,
  RESUMMARY_THINKING_PREFILL,
  RULE_ABSOLUTE_TIME_LANGUAGE,
  RULE_ITEMS,
  RULE_NPCS,
  RULE_PLANS,
  RULE_RELATION_MOMENTUM,
  RULE_SCENES,
  RULE_SCENE_FOCUS,
  RULE_SUMMARY_COMPOSITION,
  RULE_SUMMARY_WRITE,
  MEMORY_BRIEFING_END,
  SUMMARY_PROMPT,
  SUMMARY_FACT_PREPARATION,
  SUMMARY_FACT_VERIFICATION,
  SUMMARY_OUTPUT_PROTOCOL,
  THINKING_CHECKLIST,
} from './prompts';

const originalPrompts = { ...apiSettings.prompts };
const originalVerbosity = apiSettings.verbosity;

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
});

const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User',
  char: 'Character',
  time: '2026/9/8 10:00',
  location: 'School',
  protagonist: {},
  sceneFocus: null,
  lifeDetails: [],
  items: [],
  itemLog: [],
  scenes: [],
  npcs: [],
  openPlans: [],
  resolvedPlans: [],
  history: 'Earlier events.',
  content: 'The current passage.',
  hasTimeTags: true,
  varsState: {},
  varsMeaning: '',
  varsRule: '',
};

function expectFactWorkflow(text: string) {
  expect(text.split(SUMMARY_FACT_PREPARATION)).toHaveLength(2);
  expect(text.split(SUMMARY_FACT_VERIFICATION)).toHaveLength(2);
  expect(text.indexOf(SUMMARY_FACT_PREPARATION)).toBeLessThan(text.indexOf(SUMMARY_FACT_VERIFICATION));
  expect(text).not.toMatch(/候选记录:|取舍记录:|漏提取复查:|覆盖核对:|数量核对:|修正结论:|字段核对:|描述证据:|计划核对:|F编号|步骤一至七/);
}

function combined(parts: ReturnType<typeof buildSummaryPrompt>): string {
  return `${parts.system}\n\n${parts.user}`;
}

describe('summary composition contract', () => {
  it('keeps facts in their own stages without prescribing a fixed sentence order', () => {
    for (const rule of [
      '按剧情先后把状态、比较基准和限制放在对应阶段',
      '不强制前置或套固定句式',
      '中途变化不得提前套用于更早阶段',
      '无相关事实就直接写事件',
      '保持单段自然叙述,不加标题、列表或新字段',
    ]) {
      expect(RULE_SUMMARY_COMPOSITION).toContain(rule);
    }
    expect(RULE_SUMMARY_COMPOSITION).not.toMatch(/先基准后事件|每个阶段先用|例如|比如|孤儿院|联赛|二转|三转/);
  });

  it('cuts nonessential action detail while preserving actors, means, outcomes and budgets', () => {
    for (const rule of [
      '在本任务篇幅内先压缩重复过程和修饰',
      '保留主体、关键手段、结果、了结与必要因果',
      '不让动作细节挤掉关键事实及其限定',
    ]) {
      expect(RULE_SUMMARY_COMPOSITION).toContain(rule);
    }
    expect(RESUMMARY_PROMPT).toContain('核心动作不能空泛化');
    expect(RESUMMARY_PROMPT).not.toContain('严禁将具体动作抽象化');
    for (const checklist of [THINKING_CHECKLIST, buildBatchThinking(2).checklist, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).not.toContain(RULE_SUMMARY_COMPOSITION);
    }
  });

  it('requires cutting off by omission instead of boundary narration', () => {
    for (const rule of [
      '截断靠"不写"、不靠"声明"',
      '以最后一个具体动作/对话自然收尾',
      '指代材料的词',
      '交代材料边界或未发生内容的句子收尾',
    ]) {
      expect(RULE_SUMMARY_WRITE).toContain(rule);
    }
    expect(RULE_SUMMARY_WRITE).not.toContain('原文未写出');
    expect(SUMMARY_PROMPT).toContain('截断靠"不写"');
  });
});

describe('summary fact workflow', () => {
  it('checks structured state before summary preparation and verification', () => {
    expectFactWorkflow(THINKING_CHECKLIST);
    for (const heading of ['1b. 主角档案盘点', '1c. 局势盘点', '1d. 生活细节盘点', '2. 物品清点', '2b. 场景盘点', '2c. NPC 盘点', '3. 悬念簿清算']) {
      expect(THINKING_CHECKLIST).toContain(heading);
      expect(THINKING_CHECKLIST.indexOf(heading)).toBeLessThan(THINKING_CHECKLIST.indexOf(SUMMARY_FACT_PREPARATION));
    }
    expect(THINKING_CHECKLIST.indexOf(SUMMARY_FACT_VERIFICATION))
      .toBeLessThan(THINKING_CHECKLIST.indexOf('5. 格式自检'));
    expect(THINKING_CHECKLIST).toContain('写进 summary 不代替对应字段的更新');
    expect(THINKING_CHECKLIST).toContain('不为填满字段制造变动');
    expect(buildSummaryThinking(args.user).prefill).toContain('先定位本楼并核对物品、场景、人物、计划等状态变化,再整理摘要');
  });

  it('retains the specialized checks and their existing safeguards', () => {
    for (const rule of [
      '1. 本楼定位',
      '1b. 主角档案盘点',
      '1c. 局势盘点',
      '1d. 生活细节盘点',
      '2. 物品清点',
      '2b. 场景盘点',
      '2c. NPC 盘点',
      '3. 悬念簿清算',
      '4. summary 收笔位置确认',
      '5. 格式自检',
      '别按时间流逝重写',
      '只处理本轮正文里**新发生**的变动',
      'carried:false',
      'carried:true',
      '物品换地方却不改 location',
      'desc 写**累积后的完整描述**',
      '为新引入的每一级各写一条带 desc 的 add',
      '用 reparent 把它挂到正确上级',
      '即时快照该变就变',
      'relation 不动、事件写 summary',
      '暂时分开不 remove',
      'cancelled(取消/作废),不是 done',
      '跨场景',
      '待揭晓事实',
      '已启动外部事件',
      '现代/数字日期的两端是否都保留了完整年份',
    ]) {
      expect(THINKING_CHECKLIST).toContain(rule);
    }
  });

  it('covers evidence, temporal boundaries, comparisons and reverse verification without story examples', () => {
    for (const rule of [
      '关键事件与结果、状态变化、明确情报、比较基准',
      '主体、说话人、关键数值与范围、确定程度',
      '条件连同受影响对象及具体影响保留',
      '区分建议、已决定、已启动与已完成',
      '不将人物说法自动当作客观事实',
      '不让旧状态冒充现状或把新状态倒写进过去',
      '局部观察不扩大为普遍规则',
      '冲突未获解释时保留分歧',
      '不自行编造原因、精确时间或结论',
      '不因删日常过程而丢掉其中的重要事实',
      '临时但仍有效的限制也可进入 summary',
      '不套用长期档案的准入门槛',
    ]) {
      expect(SUMMARY_FACT_PREPARATION).toContain(rule);
    }
    expect(SUMMARY_FACT_VERIFICATION).toContain('对照原材料');
    expect(SUMMARY_FACT_VERIFICATION).toContain('关键事实、限定与了结结果在 summary 中实际保留');
    expect(SUMMARY_FACT_VERIFICATION).toContain('合并不能吞掉独立事实');
    expect(SUMMARY_FACT_VERIFICATION).toContain('删除无依据的推断和续写');
    expect(SUMMARY_FACT_VERIFICATION).toContain('不能仅因已写入状态字段就从 summary 省略');
    expect(SUMMARY_FACT_PREPARATION + SUMMARY_FACT_VERIFICATION).not.toMatch(/例如|比如|孤儿院|联赛|二转|三转/);
  });

  it('uses brief visible records and keeps each checklist within a compact size budget', () => {
    for (const [checklist, maxChars] of [
      [THINKING_CHECKLIST, 6500],
      [buildBatchThinking(2).checklist, 1600],
      [RESUMMARY_THINKING_CHECKLIST, 1300],
    ] as const) {
      expectFactWorkflow(checklist);
      expect(checklist.length).toBeLessThan(maxChars);
      expect(checklist).toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
    expect(SUMMARY_FACT_PREPARATION.length + SUMMARY_FACT_VERIFICATION.length).toBeLessThan(600);
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('回复正文先输出一个简短的 <thinking>...</thinking>');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不复述规范或预写摘要/JSON 草稿');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不要求逐段登记、事实编号、多轮表格或数量统计');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('需要引用时沿用输入段号或原文短证据');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不要开启第二个块');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('没有预填充则自行打开');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不把来源标记或核查记录写进最终 JSON');
    expect(THINKING_CHECKLIST).toContain('确无变化的模块可合并注明无变化,但不能跳过核查');
  });

  it('gives compression its own checklist and prefill without ledger updates', () => {
    expectFactWorkflow(RESUMMARY_THINKING_CHECKLIST);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('待融合摘要就是本次事实来源');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不得恢复输入中已缺失的事实');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('需要定位时沿用输入的 [编号]');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不逐段填表');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('根键只有 summary');
    expect(RESUMMARY_THINKING_CHECKLIST).not.toContain('items.add');
    expect(RESUMMARY_THINKING_PREFILL).toBe('<thinking>');
  });

  it('checks final state operations without repeating field audits or dropping inference exceptions', () => {
    for (const rule of [
      '实际输出的状态操作与盘点结论一致',
      '该更新的字段没有遗漏',
      '同一事实在 summary 与其它字段中的时间、范围和行动进度一致',
      '删除、清空或 resolve 须有依据',
      '整体覆盖保留未失效的旧要点',
      '不重复列字段证据表',
      '时间锚点仅按本任务时间规则处理',
      '主要 NPC 离场演变仅限 outfit/location/condition',
      '自定义变量按其原有规则核对触发依据及操作',
    ]) {
      expect(THINKING_CHECKLIST).toContain(rule);
    }
    expect(RULE_SCENES).toContain('当次观察、实时读数、短暂在场或一次遭遇不能改写为地点的长期属性');
    expect(RULE_SCENES).toContain('不能为满足 desc 必填而编造恒常特征');
  });

  it('checks deadlines separately from outcomes and does not fill optional scene fields by default', () => {
    expect(THINKING_CHECKLIST).toContain('用本楼结束时间逐条比较原截止时间');
    expect(THINKING_CHECKLIST).toContain('不同纪年或模糊期限不可可靠比较时不强判');
    expect(THINKING_CHECKLIST).toContain('已过期但结果未确认,保持原条目');
    expect(THINKING_CHECKLIST).toContain('不得自动 resolve');
    expect(THINKING_CHECKLIST).toContain('不能用旧快照时间或现实日期');
    expect(THINKING_CHECKLIST).toContain('整卡重写不等于填满可选字段');
    expect(THINKING_CHECKLIST).toContain('危险或行动难度本身不算');
    expect(THINKING_CHECKLIST).toContain('不得替主角选择行动');
  });

  it('requires admission evidence before optional scene values and before composing descriptions', () => {
    for (const rule of [
      '无依据的可选字段省略',
      'tension 只记有依据的持续社交张力',
      'pendingBeat 只记明确预告/约定或已启动待结果的行动',
      '发现目标、存在威胁或提出建议不等于决定下一步',
      'path 与描述都须有依据',
      '沿用仍有效的旧描述,不把旧事写成本轮新增',
      '临时观察如确需记入 desc 须标明本次所见',
      '不能写成长久属性',
      '不能为补齐描述编造设施或特征',
    ]) {
      expect(THINKING_CHECKLIST).toContain(rule);
    }
  });
});

describe('relationship retention and departure protocol', () => {
  it('keeps the relationship-momentum rule in every built-in and custom summary path', () => {
    for (const text of [RULE_SUMMARY_WRITE, SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(text).toContain('【关系线保留】');
    }
    for (const contract of ['手搭在他手边', '自X起', '重复的亲密互动/调情', '关系有所变化', '证据边界不变']) {
      expect(RULE_RELATION_MOMENTUM).toContain(contract);
    }
    apiSettings.prompts.summary = 'CUSTOM {{content}}';
    expect(buildSummaryPrompt(args).system).toContain(RULE_RELATION_MOMENTUM);
    for (const level of [1, 2] as const) {
      Object.assign(apiSettings.prompts, { resummary: '', resummary2: '' });
      if (level === 1) apiSettings.prompts.resummary = 'CUSTOM {{content}}';
      else apiSettings.prompts.resummary2 = 'CUSTOM {{content}}';
      expect(buildResummaryPrompt({ ...args, level }).system).toContain(RULE_RELATION_MOMENTUM);
    }
  });

  it('no longer treats intimacy or flirting as deletable repeated process when it forms a trend', () => {
    expect(RESUMMARY_PROMPT).toContain('关系线(与上面同优');
    expect(RESUMMARY2_PROMPT).toContain('承载关系推进/退缩的亲密互动与调情');
    expect(RESUMMARY2_PROMPT).not.toContain('购物、换衣、调情等过程');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('关系线保留');
    expect(THINKING_CHECKLIST).toContain('关系线保留');
  });

  it('ships the departure protocol: presence markers, unknown whereabouts and sceneFocus reconciliation', () => {
    for (const contract of ['〔在场〕/〔同区域〕/〔不在场〕', '在场对账', '所在不明', 'location 填空字符串', 'sceneFocus.participants 改成与实际在场名单一致']) {
      expect(RULE_NPCS).toContain(contract);
    }
    expect(SUMMARY_PROMPT).toContain('按**本楼开始前**的状态算好');
    expect(SUMMARY_PROMPT).toContain('离场去向未明填空字符串');
    expect(SUMMARY_PROMPT).toContain('同步修正 participants');
    expect(THINKING_CHECKLIST).toContain('在场对账');
    expect(THINKING_CHECKLIST).toContain('所在不明');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_END).toContain('不是上限');
    expect(MEMORY_BRIEFING_END).toContain('继续发展或转折');
    expect(MEMORY_BRIEFING_END).toContain('不代表正文文风');
  });
});

describe.each(['detailed', 'concise'] as const)('prompt assembly (%s)', verbosity => {
  beforeEach(() => {
    apiSettings.verbosity = verbosity;
  });

  it.each([false, true])('keeps single-floor templates and time rules intact (custom=%s)', custom => {
    if (custom) apiSettings.prompts.summary = 'CUSTOM SUMMARY {{content}} {{summary_words}}';
    const parts = buildSummaryPrompt(args);
    const prompt = combined(parts);
    expect(prompt).toContain(args.content);
    expect(prompt).toContain(verbosity === 'detailed' ? '150-300' : '80-150');
    expect(prompt).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    expect(prompt).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(prompt).not.toMatch(/\{\{(?:content|summary_words)\}\}/);
    expect(parts.user).not.toContain(RULE_SUMMARY_COMPOSITION);
    if (custom) {
      expect(prompt).toContain('CUSTOM SUMMARY');
      expect(parts.system).not.toContain(RULE_SUMMARY_COMPOSITION);
    } else {
      expect(prompt).toContain('持续事实与背景参照');
      expect(parts.system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
    }
    // The existing caller sends this system checklist for both template paths.
    expectFactWorkflow(THINKING_CHECKLIST);
  });

  it('keeps batch floor boundaries, count macros and the summary-only protocol', () => {
    const parts = buildBatchSummaryPrompt({ ...args, floorCount: 3 });
    const prompt = combined(parts);
    const thinking = buildBatchThinking(3);
    expectFactWorkflow(thinking.checklist);
    expect(thinking.checklist).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(thinking.checklist).toContain('这批共 3 楼');
    expect(thinking.checklist).toContain('不得借后面楼补齐当前楼的结论');
    expect(thinking.checklist).toContain('[M消息序号-P段序号] 只供定位,不等于结果的 n');
    expect(thinking.checklist).toContain('每个元素含 n / summary / timeStart / timeEnd');
    expect(thinking.checklist).toContain('location / locationPath');
    expect(thinking.checklist).toContain('不续写、不跨入下一楼');
    expect(thinking.checklist).toContain('现代/数字日期的两端都必须包含完整年份');
    expect(thinking.prefill).toContain('数组长度 3');
    expect(prompt).toContain('持续事实与背景参照');
    expect(parts.system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
    expect(parts.user).not.toContain(RULE_SUMMARY_COMPOSITION);
    expect(prompt).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(parts.user).not.toContain('【输出铁律】');
    expect(parts.system).toContain('【批量任务说明(关键)】');
    expect(prompt + thinking.checklist).not.toMatch(/严禁输出 JSON 以外|不要思维链|不要输出思维链/);
    expect(prompt + thinking.checklist + thinking.prefill).not.toMatch(/\{\{\w+\}\}/);
  });

  it.each([
    [1, false], [1, true],
    [2, false], [2, true],
    [3, false], [3, true],
  ] as const)('checks compression facts and preserves budgets (level=%s, custom=%s)', (level, custom) => {
    if (custom) {
      apiSettings.prompts.resummary = 'CUSTOM L1 {{content}} {{resummary_words}}';
      apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}} {{target_min}} {{target_max}} {{target}}';
    }
    const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
    const prompt = combined(parts);
    expectFactWorkflow(RESUMMARY_THINKING_CHECKLIST);
    expect(prompt).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    expect(prompt).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(prompt).not.toContain(SUMMARY_FACT_PREPARATION);
    expect(prompt).not.toMatch(/不要思维链|不要输出思维链|严禁输出 JSON 以外/);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(parts.user).not.toContain(RULE_SUMMARY_COMPOSITION);
    if (custom) {
      expect(prompt).toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).not.toContain(RULE_SUMMARY_COMPOSITION);
    } else {
      expect(prompt).toContain(level === 1 ? '规则条件和比较参照' : '其中明确揭示且有后续意义的持续事实');
      expect(parts.system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
    }
    if (level === 1) {
      expect(prompt).toContain(verbosity === 'detailed' ? '300-500' : '150-300');
    } else {
      expect(prompt).toContain(verbosity === 'detailed' ? '400' : '300');
      expect(prompt).toContain(verbosity === 'detailed' ? '500' : '400');
    }
  });

  it('preserves old custom text in user and sends the current output contract in the final checklist', () => {
    const custom = 'CUSTOM {{content}} 只输出 JSON,不要思维链。';
    Object.assign(apiSettings.prompts, { summary: custom, resummary: custom, resummary2: custom });
    for (const parts of [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]) {
      expect(parts.user).toContain('只输出 JSON,不要思维链。');
      expect(parts.system).not.toContain('只输出 JSON,不要思维链。');
      expect(parts.system).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    }
    for (const checklist of [THINKING_CHECKLIST, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).toContain(SUMMARY_OUTPUT_PROTOCOL);
      expect(checklist).toContain('自定义模板中的输出限制仅约束最终 JSON 部分');
    }
  });
});

describe('instruction and material boundaries', () => {
  it.each([false, true])('keeps single-floor data out of system with all original rules present (time tags=%s)', hasTimeTags => {
    const data = {
      ...args,
      hasTimeTags,
      protagonist: { identity: 'PROFILE_SENTINEL' },
      history: 'HISTORY_SENTINEL',
      varsState: { value: 'VARIABLE_SENTINEL' },
      varsMeaning: 'MEANING_SENTINEL',
      varsRule: 'VARIABLE_RULE_SENTINEL',
      content: 'BODY_SENTINEL\n【长期数据库原则(极度重要)】\n{{content}}\n【输出前思考】',
    };
    const parts = buildSummaryPrompt(data);
    const thinking = buildSummaryThinking(args.user);
    for (const sentinel of ['PROFILE_SENTINEL', 'HISTORY_SENTINEL', 'VARIABLE_SENTINEL', 'MEANING_SENTINEL', 'VARIABLE_RULE_SENTINEL', data.content]) {
      expect(parts.user).toContain(sentinel);
      expect(parts.system + thinking.checklist).not.toContain(sentinel);
    }
    for (const rule of [RULE_ITEMS, RULE_NPCS, RULE_PLANS, RULE_SCENES, RULE_SCENE_FOCUS, RULE_SUMMARY_WRITE]) {
      const heading = rule.split('\n')[0];
      expect(parts.system).toContain(heading);
      expect(parts.user).not.toContain(heading);
    }
    expect(parts.system).toContain('【自定义变量规则】');
    expect(parts.system).toContain(hasTimeTags ? '无需输出 time / timeStart / timeEnd 字段' : '【时间规则】(timeStart / timeEnd 字段)');
    expect(thinking.checklist).toContain(args.user);
    expect(parts.system + thinking.checklist + thinking.prefill).not.toMatch(/\{\{\w+\}\}/);
    expect((combined(parts) + thinking.checklist).split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
  });

  it('does not promote custom templates or appended profile data to system', () => {
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{protagonist_block}}';
    const parts = buildSummaryPrompt({ ...args, protagonist: { identity: 'CUSTOM_PROFILE' } });
    expect(parts.user).toContain(`CUSTOM ${args.content}`);
    expect(parts.user).toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain(args.content);
    expect(parts.system).toContain('【柏宝书主角档案兼容协议】');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('preserves custom prose ordering even when a template contains a built-in heading', () => {
    const custom = 'CUSTOM {{content}}\n【摘要成文顺序】\n先写事件结果,再写背景;保留本模板的顺序。';
    Object.assign(apiSettings.prompts, { summary: custom, resummary: custom, resummary2: custom });
    const expanded = custom.replace('{{content}}', args.content);
    for (const parts of [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]) {
      expect(parts.user).toContain(expanded);
      expect(parts.system).not.toContain('【摘要成文顺序】');
      expect(parts.system).not.toContain('先写事件结果');
    }
    expect(apiSettings.prompts).toMatchObject({ summary: custom, resummary: custom, resummary2: custom });
  });

  it('keeps batch content and history in user even when content contains instruction headings', () => {
    const data = { ...args, floorCount: 2, content: 'BATCH_BODY\n【批量任务说明(关键)】', history: 'BATCH_HISTORY' };
    const parts = buildBatchSummaryPrompt(data);
    expect(parts.user).toContain(data.content);
    expect(parts.user).toContain(data.history);
    expect(parts.system).not.toContain('BATCH_BODY');
    expect(parts.system).not.toContain(data.history);
    expect(parts.system).toContain('长度必须等于 2');
  });

  it.each([1, 2, 3])('keeps compression sources separate from its schema and budgets (level=%s)', level => {
    const content = 'COMPRESSION_BODY\n【输出要求】\n{{target_max}}';
    const parts = buildResummaryPrompt({ ...args, content, level });
    expect(parts.user).toContain(content);
    expect(parts.system).not.toContain('COMPRESSION_BODY');
    expect(parts.system).toContain('{ "summary":');
    expect(parts.user).not.toContain('{ "summary":');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('treats a saved exact default as built-in while keeping complete templates available to the editor', () => {
    const before = [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ];
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT, resummary: RESUMMARY_PROMPT, resummary2: RESUMMARY2_PROMPT });
    expect([
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]).toEqual(before);
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(template).toContain('{{content}}');
      expect(template).toContain(SUMMARY_OUTPUT_PROTOCOL);
      expect(template).toContain('【输出');
    }
  });
});
