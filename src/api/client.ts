import { getContext } from '@/st/context';
import type { ApiChannel } from './settings';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 测试渠道时备用的 /v1 形式。只在首个地址明确返回 404/405 时才会尝试。 */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * 给完整请求生命周期套超时:不仅覆盖 fetch 建连,也覆盖非流式 JSON 读取和流式 SSE 读取。
 * 外部 signal 仍可提前取消;只有本定时器触发时才转换成明确的超时报错。
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label}超时(>${timeoutSec}秒)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * 构造发给 ST 代理的请求体(纯函数,便于测两条分支的产物)。
 *
 * 两条分支,按渠道有没有设思考强度二选一:
 *
 * ① 未设(reasoningEffort 为空 = auto):走 `chat_completion_source: 'openai'`,
 *    与加本功能之前**逐字节一致**——存量用户零变化。
 *
 * ② 已设:走 `'custom'`。因为 ST 代理对 openai 源的 reasoning_effort 卡**模型名白名单**
 *    (src/constants.js 的 OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),
 *    模型名对不上就静默丢弃、还照样返回 200(实测确认),用户设了却无效且看不出来。
 *    custom 源的 custom_include_body 由服务端 mergeObjectWithYaml 直接并进上游请求体,
 *    不过任何白名单,任意字段/嵌套对象都能透传。
 *
 * 两条路都仍然走 ST 服务端转发(同一个 /generate 端点),没有浏览器直连,
 * 因此 CORS、密钥不落浏览器、SSE 转发等性质完全不变。
 *
 * custom 源的两个坑(都已规避):
 * - 它**不读 proxy_password**,只读 ST 自己存的 Custom 密钥,所以 key 必须靠
 *   custom_include_headers 注入 Authorization(服务端 `...headers` 排在默认
 *   Authorization 之后,覆盖成立);
 * - custom_include_* 是 YAML 字符串且**解析失败会静默忽略**(util.js 的 catch 是空的)。
 *   key 里带 `:` `#` `{` 或以 `*` 开头都会让 YAML 解析炸 → header 没注入 →
 *   退回用 ST 的 Custom 密钥,可能把用户另一个服务商的 key 发到本端点。
 *   故一律用 JSON.stringify 生成(YAML 是 JSON 的超集),转义交给它,不手拼。
 *
 * 另:请求体固定带 `tool_choice: 'none'`,这是给第三方 fetch 拦截器的声明式放行握手。
 * 酒馆助手预设脚本(如 Kemini Dramatron 面板)可能 monkey-patch `window.parent.fetch`,
 * 拦截所有 `/api/backends/…/generate` 请求并塞入合成工具 + 控制消息,把摘要劫持成
 * 工具调用(实测拖慢数倍)。这类拦截器普遍支持「调用方自带 tool_choice 就放行」
 * (Dramatron 的 callerControlsTools 对 'none' 明确 bypass),所以我们主动声明不用工具。
 * 对上游无影响:ST 服务端只在 tools 为非空数组时才转发 tool_choice
 * (src/endpoints/backends/chat-completions.js),本函数从不发 tools,该字段到不了服务商。
 *
 * (与柏宝绘 src/api/client.ts 的同名函数同源,行为保持一致。)
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // 不用工具:见函数头注释,防第三方 fetch 拦截器把摘要改写成工具调用
    tool_choice: 'none',
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  // 注:固定路由字段(chat_completion_source/reverse_proxy 等)不应被删,但全凭用户填写,
  // 这里只做忠实剔除——文案会提示填采样参数名(temperature/max_tokens/...)。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

/**
 * 整理成 Gemini 能接受的消息序。
 *
 * 摘要请求的思考清单是一条 system,排在 user 后面。
 * Gemini 拒绝「user 之后再出现 system」,直接 400。
 * 丢掉末尾残留的 assistant,并把所有 system(含思考清单)挪到最前,让请求以 user 结束。
 * 清单内容仍会发给模型。其他模型保持原顺序。
 */
export function messagesWithoutPrefill(messages: ChatMsg[]): ChatMsg[] {
  const trimmed =
    messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : messages;
  const systems: ChatMsg[] = [];
  const rest: ChatMsg[] = [];
  for (const message of trimmed) {
    if (message.role === 'system') systems.push(message);
    else rest.push(message);
  }
  return [...systems, ...rest];
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const stream = channel.stream ?? false;
  // Gemini 拒绝 user 后面再跟 system。其他模型保留思考清单在 user 之后的原顺序。
  const outMessages = /gemini/i.test(channel.model) ? messagesWithoutPrefill(messages) : messages;
  const body = buildRequestBody(channel, outMessages, reverseProxy, stream);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, opts.signal, '副 API 请求', async signal => {
    const resp = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
    }

    // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
    if (stream) {
      const content = await readSseContent(resp);
      if (!content) throw new ApiError('副 API 返回空内容');
      return content;
    }

    const data = await resp.json();
    if (data?.error) {
      throw new ApiError(data.error.message || '副 API 返回错误');
    }

    const content = extractContent(data);
    if (!content) throw new ApiError('副 API 返回空内容');
    return content;
  });
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 */
async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行解析,保留最后一段不完整的行到下次
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
        if (typeof delta === 'string') out += delta;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // 单行解析失败忽略(可能是注释行/心跳)
      }
    }
  }
  return out.trim();
}

/** 从标准 OpenAI 响应体提取文本 */
function extractContent(data: any): string {
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? '';
  return typeof content === 'string' ? content.trim() : contentToText(content);
}

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 摘要/总结跟随主 API 时的响应上限:够装下思维链 + JSON,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 65535;

/** 各聊天补全源在 oai_settings 里存放模型名的字段。与 ST getChatCompletionModel 对齐。 */
const MAIN_API_MODEL_KEY: Record<string, string> = {
  claude: 'claude_model',
  openai: 'openai_model',
  opencode: 'opencode_model',
  makersuite: 'google_model',
  vertexai: 'vertexai_model',
  openrouter: 'openrouter_model',
  ai21: 'ai21_model',
  mistralai: 'mistralai_model',
  custom: 'custom_model',
  cohere: 'cohere_model',
  perplexity: 'perplexity_model',
  groq: 'groq_model',
  siliconflow: 'siliconflow_model',
  minimax: 'minimax_model',
  aws_bedrock: 'aws_bedrock_model',
  electronhub: 'electronhub_model',
  chutes: 'chutes_model',
  nanogpt: 'nanogpt_model',
  deepseek: 'deepseek_model',
  aimlapi: 'aimlapi_model',
  xai: 'xai_model',
  pollinations: 'pollinations_model',
  cometapi: 'cometapi_model',
  moonshot: 'moonshot_model',
  fireworks: 'fireworks_model',
  azure_openai: 'azure_openai_model',
  zai: 'zai_model',
  workers_ai: 'workers_ai_model',
};

/** OpenRouter 选「在官网选择模型」时的占位值,不能当成真实模型名发出去。 */
const OPENROUTER_WEBSITE_MODEL = 'OR_Website';

/**
 * 只从主界面设置里抄连接身份,不抄正文预设。
 * 停止串、角色预填充、工具广告、提示词后处理都会把摘要 JSON 切掉或改写成扮演。
 */
const MAIN_API_CONNECTION_KEYS = [
  'secret_id',
  'custom_url',
  'custom_api_format',
  'custom_include_body',
  'custom_include_headers',
  'custom_exclude_body',
  'azure_base_url',
  'azure_deployment_name',
  'azure_api_version',
  'vertexai_auth_mode',
  'vertexai_region',
  'vertexai_express_project_id',
  'opencode_endpoint',
  'opencode_api_format',
  'zai_endpoint',
  'siliconflow_endpoint',
  'pollinations_endpoint',
  'moonshot_endpoint',
  'minimax_endpoint',
  'workers_ai_account_id',
  'aws_bedrock_region',
  'aws_bedrock_custom_template',
  'aws_bedrock_custom_response_path',
  'aws_bedrock_custom_stream_path',
  'nanogpt_provider',
] as const;

function settingText(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 当前聊天补全源实际使用的模型名。 */
export function mainApiModel(settings: Record<string, unknown>): string {
  const source = settingText(settings, 'chat_completion_source');
  const key = MAIN_API_MODEL_KEY[source];
  const model = key ? settingText(settings, key) : '';
  if (source === 'openrouter' && model === OPENROUTER_WEBSITE_MODEL) return '';
  return model;
}

/** o1 / gpt-5 家族不接受 max_tokens,要改成 max_completion_tokens。 */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(?:openai\/)?(?:o1|o3|o4)\b/.test(model) || /gpt-5/.test(model);
}

/** 这些型号仍接受 temperature。其余推理型号带上采样参数会直接 400。 */
function keepsSamplingParams(model: string): boolean {
  return /gpt-5-chat-latest/.test(model)
    || (/gpt-5\.(?:1|2|3|4)/.test(model) && !/chat-latest/.test(model));
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 构造「跟随主 API」的请求体。
 *
 * 直接打 ST 的 /generate,只带当前连接(源、模型、密钥、反代地址)和我们自己的消息。
 * 不经过 generateRaw:那条路会在正文生成进行中广播 prompt-ready,被预设脚本改成角色扮演,
 * 再被停止串和 AI 输出正则切掉 JSON。这里不改全局 max tokens,所以可以和正文请求并行。
 */
export function buildMainApiRequestBody(
  settings: Record<string, unknown>,
  messages: ChatMsg[],
): Record<string, unknown> {
  const source = settingText(settings, 'chat_completion_source');
  const model = mainApiModel(settings);
  const body: Record<string, unknown> = {
    type: 'quiet',
    chat_completion_source: source,
    model,
    messages,
    max_tokens: MAIN_API_RESPONSE_LENGTH,
    stream: false,
    // 给防截断类 fetch 拦截器的放行握手。ST 服务端只在 tools 非空时才转发给上游。
    tool_choice: 'none',
    // 摘要的 system 就是任务规则,必须按系统消息送出,不受角色卡「不使用系统提示」影响。
    use_sysprompt: true,
    enable_web_search: false,
    request_images: false,
  };

  const temperature = finiteNumber(settings.temp_openai);
  if (temperature !== undefined) body.temperature = temperature;
  const topP = finiteNumber(settings.top_p_openai);
  if (topP !== undefined) body.top_p = topP;
  const topK = finiteNumber(settings.top_k_openai);
  if (topK !== undefined && topK > 0) body.top_k = topK;

  const effort = settingText(settings, 'reasoning_effort');
  if (effort && effort !== 'auto') body.reasoning_effort = effort;

  if (typeof settings.reverse_proxy === 'string' && settings.reverse_proxy.trim()) {
    body.reverse_proxy = settings.reverse_proxy.trim();
    if (typeof settings.proxy_password === 'string') body.proxy_password = settings.proxy_password;
  }

  for (const key of MAIN_API_CONNECTION_KEYS) {
    const value = settings[key];
    if (typeof value === 'string' && value.trim()) body[key] = value.trim();
  }
  if (settings.custom_claude_prompt_caching === true) body.custom_claude_prompt_caching = true;
  if (settings.custom_openai_responses_websocket === true) body.custom_openai_responses_websocket = true;
  if (settings.aws_bedrock_use_custom_template === true) body.aws_bedrock_use_custom_template = true;
  if (settings.nanogpt_payg_override === true) body.nanogpt_payg_override = true;

  if (usesMaxCompletionTokens(model)) {
    body.max_completion_tokens = MAIN_API_RESPONSE_LENGTH;
    delete body.max_tokens;
    if (!keepsSamplingParams(model)) {
      delete body.temperature;
      delete body.top_p;
    }
  }
  return body;
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(contentToText).filter(Boolean).join('\n').trim();
  if (!value || typeof value !== 'object') return '';
  const part = value as Record<string, unknown>;
  const bits = [part.text, part.thinking, part.reasoning, part.reasoning_content]
    .map(contentToText)
    .filter(Boolean);
  if (Array.isArray(part.parts)) bits.push(contentToText(part.parts));
  if (!bits.length && typeof part.content === 'string') bits.push(part.content.trim());
  return bits.filter(Boolean).join('\n').trim();
}

/**
 * 取出主 API 响应里的正文。可见内容里已经有 JSON 就只用它;
 * 否则把思维链一并带上,避免推理模型把摘要写进 reasoning、正文只留一句道歉。
 */
export function extractMainApiContent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const root = data as Record<string, unknown>;
  const choice = Array.isArray(root.choices) ? root.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message && typeof choice.message === 'object'
    ? choice.message as Record<string, unknown>
    : undefined;
  const visible = contentToText(message?.content) || contentToText(choice?.text);
  if (visible.includes('{')) return visible;
  const hidden = [
    message?.reasoning_content,
    message?.reasoning,
    root.content,
    root.responseContent,
  ].map(contentToText).filter(Boolean).join('\n');
  return [hidden, visible].filter(Boolean).join('\n').trim();
}

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 聊天补全实际不调用它,它仍作为文本补全和旧版本的兜底。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/** 聊天补全可以绕开 generateRaw,自己把当前连接打到 /generate。 */
function canIsolateMainChat(ctx: NonNullable<ReturnType<typeof getContext>>): boolean {
  const source = settingText(ctx.chatCompletionSettings ?? {}, 'chat_completion_source');
  if (!source) return false;
  // 文本补全没有这套聊天补全请求体,继续走 generateRaw。
  return ctx.mainApi == null || ctx.mainApi === '' || ctx.mainApi === 'openai';
}

/**
 * 用「当前主 API」发一次补全。只发调用方给的消息,不带聊天历史。
 *
 * 聊天补全直接请求 ST 代理,和正在进行的正文生成互不改写,因此自动摘要可以并行。
 * 文本补全仍走 generateRaw。
 */
export async function requestViaMainApi(messages: ChatMsg[], opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (canIsolateMainChat(ctx)) {
    return requestIsolatedMainChat(ctx, messages, opts);
  }
  if (typeof ctx.generateRaw !== 'function') {
    throw new ApiError('当前 ST 版本不支持 generateRaw,无法跟随主 API');
  }
  const prompt = mainApiRejectsPrefill() ? messagesWithoutPrefill(messages) : messages;
  const content = (await ctx.generateRaw({ prompt, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!content) throw new ApiError('主 API 返回空内容');
  return content;
}

async function requestIsolatedMainChat(
  ctx: NonNullable<ReturnType<typeof getContext>>,
  messages: ChatMsg[],
  opts: RequestOptions,
): Promise<string> {
  const settings = ctx.chatCompletionSettings ?? {};
  const prompt = mainApiRejectsPrefill() ? messagesWithoutPrefill(messages) : messages;
  const body = buildMainApiRequestBody(settings, prompt);
  if (!body.model) throw new ApiError('主 API 未选择模型,无法跟随');

  const resp = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(`主 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
  }
  const data = await resp.json();
  if (data?.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message;
    throw new ApiError(message || '主 API 返回错误');
  }
  const content = extractMainApiContent(data);
  if (!content) throw new ApiError('主 API 返回空内容');
  return content;
}

/** 主界面当前模型是 Gemini(MakerSuite / Vertex,或模型名里带 gemini)时不能发 assistant 预填充。 */
export function mainApiRejectsPrefill(): boolean {
  const settings = getContext()?.chatCompletionSettings;
  if (!settings) return false;
  const source = String(settings.chat_completion_source ?? '').toLowerCase();
  if (source === 'makersuite' || source === 'vertexai') return true;
  const format = `${settings.custom_api_format ?? ''}\n${settings.opencode_api_format ?? ''}`;
  if (/gemini/i.test(format)) return true;
  const model = [
    settings.google_model,
    settings.vertexai_model,
    settings.openai_model,
    settings.custom_model,
    settings.openrouter_model,
    settings.opencode_model,
    mainApiModel(settings),
  ]
    .map(value => String(value ?? ''))
    .join('\n');
  return /gemini/i.test(model);
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: '回复"ok"两个字符即可。' }],
      primaryUrl,
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连通正常${changed ? `,已采用:${primaryUrl}` : ''},返回:${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: '回复"ok"两个字符即可。' }],
        fallbackUrl,
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连通正常,已自动改用:${fallbackUrl},返回:${reply.slice(0, 40)}`,
      };
    } catch {
      // 备用地址也失败时保留首个错误,避免把模型名等真实问题掩盖成路径错误。
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, '拉取模型', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || '拉取模型失败');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
