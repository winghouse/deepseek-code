// ============================================================
// Web Search Tool — 搜狗/Serper/Bing 三层后端
// 设计参考 Codex web_search + AION web_search/sogou_fallback
// DeepSeek API 不原生支持 web_search，使用客户端实现
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WebSearchConfig, WebSearchResult, WebSearchResultItem, WebFetchConfig, WebFetchResult } from 'deepseek-code-shared';

// ═══ Serper API Key 读取 ═══

/** 从环境变量或 ~/.deepseek-code/config.json 读取 Serper API Key */
function getSerperApiKey(): string | undefined {
  // 1. 环境变量优先
  if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY;
  // 2. 配置文件
  try {
    const configPath = path.join(os.homedir(), '.deepseek-code', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return cfg.serperApiKey || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

// ═══ URL 安全校验 ═══

/** URL 安全校验结果 */
export interface UrlValidation {
  valid: boolean;
  sanitizedUrl: string;
  error?: string;
}

/**
 * URL 安全校验 — 防止 SSRF / 内网访问 / 文件协议攻击
 *
 * 规则:
 * 1. 只允许 http / https
 * 2. 禁止 file://、ftp:// 等
 * 3. 禁止 localhost / 127.0.0.1 / 0.0.0.0 / [::1]
 * 4. 禁止内网 IP: 10.x / 172.16-31.x / 192.168.x
 * 5. 禁止 metadata 地址: 169.254.169.254
 * 6. 最大 URL 长度 2048
 */
export function validateUrl(rawUrl: string): UrlValidation {
  const trimmed = rawUrl.trim();

  if (trimmed.length === 0) {
    return { valid: false, sanitizedUrl: '', error: 'URL 不能为空' };
  }
  if (trimmed.length > 2048) {
    return { valid: false, sanitizedUrl: '', error: 'URL 过长 (最大 2048 字符)' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, sanitizedUrl: '', error: '无效的 URL 格式' };
  }

  // 规则 1: 只允许 http / https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, sanitizedUrl: '', error: `禁止协议: ${parsed.protocol}// (仅允许 http/https)` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 规则 3: 禁止 localhost (含 IPv4 / IPv6 所有变体)
  const blockedHosts = [
    'localhost', '127.0.0.1', '0.0.0.0',
    '[::1]', '::1',  // IPv6 loopback
    // IPv4-mapped IPv6 loopback
    '[::ffff:127.0.0.1]', '[::ffff:0:0]',
    '[::ffff:0.0.0.0]',
  ];
  if (blockedHosts.includes(hostname)) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问本地地址' };
  }

  // 规则 4: 禁止内网 IPv4
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问内网地址 (10.x)' };
  }
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问内网地址 (172.16-31.x)' };
  }
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问内网地址 (192.168.x)' };
  }
  // IPv4 decimal/octal/hex variants
  if (/^0x[0-9a-f]+$/i.test(hostname) || /^0[0-7]+$/.test(hostname) || /^\d{10,}$/.test(hostname)) {
    return { valid: false, sanitizedUrl: '', error: '禁止使用非标准 IP 表达 (hex/octal/decimal)' };
  }

  // 规则 4b: 禁止内网 IPv6
  if (hostname.startsWith('[fe80:') || hostname.startsWith('fe80:')) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问 IPv6 link-local 地址' };
  }
  if (hostname.startsWith('[fc') || hostname.startsWith('[fd') || hostname.startsWith('fc') || hostname.startsWith('fd')) {
    return { valid: false, sanitizedUrl: '', error: '禁止访问 IPv6 unique local 地址' };
  }
  // IPv4-mapped IPv6
  if (hostname.includes('::ffff:')) {
    const mapped = hostname.replace(/^\[|\]$/g, '').split('::ffff:')[1];
    if (mapped && /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(mapped)) {
      return { valid: false, sanitizedUrl: '', error: '禁止访问 IPv4-mapped 内网地址' };
    }
  }

  // 规则 5: 禁止 metadata 地址
  if (hostname === '169.254.169.254' || hostname === '[169.254.169.254]') {
    return { valid: false, sanitizedUrl: '', error: '禁止访问云元数据地址' };
  }

  return { valid: true, sanitizedUrl: parsed.href };
}

// ═══ 搜索后端实现 ═══

const SOGOU_URL = 'https://www.sogou.com/web';
const BAIDU_URL = 'https://www.baidu.com/s';
const BING_URL = 'https://www.bing.com/search';
const SERPER_URL = 'https://google.serper.dev/search';

/**
 * 搜狗搜索 — AION 移植，HTML 抓取，免费、境内可用
 * 参考: D:\Github\AION\aion\skills\builtin\search_fallback.py
 */
async function searchSogou(
  query: string,
  config: WebSearchConfig,
): Promise<WebSearchResultItem[]> {
  const maxResults = config.maxResults ?? 10;
  const timeout = config.timeout ?? 15000;

  // site 过滤
  const searchQuery = config.site ? `${query} site:${config.site}` : query;
  const url = `${SOGOU_URL}?query=${encodeURIComponent(searchQuery)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Sogou 返回 HTTP ${res.status}`);

    const text = await res.text();
    const results: WebSearchResultItem[] = [];
    const seen = new Set<string>();

    // 搜狗结果在 <div class="vrwrap"> 块中
    const blocks = text.split(/<div class="vrwrap/gi).slice(1);

    for (const block of blocks) {
      // URL 从 data-url 属性提取
      const linkMatch = block.match(/data-url="([^"]+)"/i);
      if (!linkMatch) continue;

      const rawLink = decodeURIComponent(
        linkMatch[1].replace(/&amp;/g, '&'),
      ).trim();
      if (!/^https?:\/\//.test(rawLink)) continue;
      if (seen.has(rawLink)) continue;

      // 标题从 data-title 属性或 <a> 标签提取
      let title = '';
      const titleMatch = block.match(/data-title="([^"]*)"/i);
      if (titleMatch) {
        title = stripHTML(decodeURIComponent(titleMatch[1]));
      } else {
        const anchorMatch = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
        title = anchorMatch ? stripHTML(anchorMatch[1]) : rawLink;
      }

      // 摘要从 fz-mid 类的 div 提取
      const snippetMatch = block.match(/<div class="[^"]*\bfz-mid\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snippetMatch ? stripHTML(snippetMatch[1]) : '';

      if (!title) title = rawLink;

      seen.add(rawLink);
      results.push({
        title: title.slice(0, 150),
        url: rawLink,
        snippet: snippet.slice(0, 300),
        relevance: 1 - results.length / maxResults,
      });

      if (results.length >= maxResults) break;
    }

    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serper API 搜索 — Google 质量结果，需 SERPER_API_KEY
 * AION 主搜索方案: D:\Github\AION\aion\skills\builtin\web_search.py
 */
async function searchSerper(
  query: string,
  config: WebSearchConfig,
): Promise<WebSearchResultItem[]> {
  const apiKey = getSerperApiKey();
  if (!apiKey) return [];

  const maxResults = config.maxResults ?? 10;
  const timeout = config.timeout ?? 15000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(maxResults, 10),
      }),
      signal: controller.signal,
    });

    if (!res.ok) return [];

    const data = await res.json() as Record<string, unknown>;
    const organic = (data.organic ?? []) as Array<Record<string, string>>;

    return organic.slice(0, maxResults).map((item, i) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      relevance: 1 - i / maxResults,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 百度搜索 — HTML 抓取，境内最常用搜索引擎
 */
async function searchBaidu(
  query: string,
  config: WebSearchConfig,
): Promise<WebSearchResultItem[]> {
  const maxResults = config.maxResults ?? 10;
  const timeout = config.timeout ?? 15000;
  const searchQuery = config.site ? query + " site:" + config.site : query;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(BAIDU_URL + "?wd=" + encodeURIComponent(searchQuery), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });

    if (!res.ok) return [];
    const html = await res.text();
    const results: WebSearchResultItem[] = [];
    const seen = new Set<string>();

    const blocks = html.split(/<div[^>]*class="[^"]*c-container[^"]*"[^>]*>/gi).slice(1);

    for (const block of blocks) {
      const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;
      const rawUrl = titleMatch[1].replace(/&amp;/g, "&");
      if (seen.has(rawUrl) || rawUrl.includes("baidu.com")) continue;

      const title = stripHTML(titleMatch[2]);
      if (!title || title.length < 3) continue;

      const snippetMatch = block.match(/<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        ?? block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

      seen.add(rawUrl);
      results.push({
        title: title.slice(0, 150),
        url: rawUrl,
        snippet: snippetMatch ? stripHTML(snippetMatch[1]).slice(0, 300) : "",
        relevance: 1 - results.length / maxResults,
      });

      if (results.length >= maxResults) break;
    }

    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行 Bing 搜索（HTML 抓取，DuckDuckGo/搜狗不可用时的降级方案）
 */
async function searchBing(
  query: string,
  config: WebSearchConfig,
): Promise<WebSearchResultItem[]> {
  const maxResults = config.maxResults ?? 10;
  const timeout = config.timeout ?? 10000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const searchQuery = config.site ? `${query} site:${config.site}` : query;
    const params = new URLSearchParams({ q: searchQuery });
    const res = await fetch(`${BING_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Bing 返回 HTTP ${res.status}`);

    const html = await res.text();
    const results: WebSearchResultItem[] = [];

    // Bing 搜索结果: <li class="b_algo"><h2><a href="URL">TITLE</a></h2><p>SNIPPET</p>
    const algoRegex = /<li class="b_algo"[\s\S]*?<\/li>/gi;
    const matches = html.match(algoRegex) ?? [];

    for (const block of matches.slice(0, maxResults)) {
      const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
      const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

      if (urlMatch && titleMatch) {
        results.push({
          title: stripHTML(titleMatch[1]).slice(0, 150),
          url: urlMatch[1].replace(/&amp;/g, '&'),
          snippet: snippetMatch ? stripHTML(snippetMatch[1]).slice(0, 300) : '',
          relevance: 1 - results.length / maxResults,
        });
      }
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

function stripHTML(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function extractTextContent(html: string): string {
  // 移除 script 和 style
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

  const text = stripHTML(cleaned)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();

  return text.slice(0, 3000);
}

// ═══ 主入口 ═══

const DEFAULT_CONFIG: WebSearchConfig = {
  contextSize: 'medium',
  maxResults: 10,
  timeout: 10000,
};

/**
 * 执行网络搜索
 *
 * 对应 Codex 的 WebSearch tool，但使用客户端 DuckDuckGo 实现
 * 而非依赖 OpenAI API 的 web_search 工具类型
 */
export async function executeWebSearch(
  query: string,
  config: WebSearchConfig = {},
): Promise<WebSearchResult> {
  const start = Date.now();
  const merged = { ...DEFAULT_CONFIG, ...config };

  function makeResult(
    success: boolean, q: string, results: WebSearchResultItem[],
    startTime: number, source: WebSearchResult['source'], error?: string,
  ): WebSearchResult {
    return {
      success,
      query: q,
      results,
      totalEstimated: results.length,
      elapsedMs: Date.now() - startTime,
      source,
      error,
    };
  }

  if (!query || query.trim().length === 0) {
    return makeResult(false, query, [], Date.now(), 'sogou', '搜索查询不能为空');
  }

  // 1. Serper API (Google 质量，需 SERPER_API_KEY)
  try {
    const results = await searchSerper(query.trim(), merged);
    if (results.length > 0) {
      return makeResult(true, query, results, start, 'serper');
    }
  } catch { /* fall through */ }

  // 2. 搜狗搜索 (免费，境内可用)
  try {
    const results = await searchSogou(query.trim(), merged);
    if (results.length > 0) return makeResult(true, query, results, start, 'sogou');
  } catch { }

  // 3. 百度搜索 (免费，境内最常用)
  try {
    const results = await searchBaidu(query.trim(), merged);
    if (results.length > 0) return makeResult(true, query, results, start, 'baidu');
  } catch { }

  // 4. Bing 搜索 (国际兜底)
  try {
    const results = await searchBing(query.trim(), merged);
    if (results.length > 0) return makeResult(true, query, results, start, 'bing');
    return makeResult(false, query, results, start, 'bing', '所有搜索引擎均无结果');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return makeResult(false, query, [], start, 'duckduckgo', `搜索不可用: ${message}`);
  }
}

// ═══ Web Fetch — 获取网页全文，支持分页遍历 ═══

const MAX_PAGES_HARD_LIMIT = 20;

/**
 * 获取指定网页的全文内容，支持自动分页遍历
 *
 * 分页检测优先级:
 * 1. <link rel="next" href="..."> (HTML 标准)
 * 2. <a rel="next" href="...">
 * 3. 链接文本匹配: "下一页"|"Next"|"»"|"›"|"next page"|"后一页"
 */
export async function executeWebFetch(
  url: string,
  config: WebFetchConfig = {},
): Promise<WebFetchResult> {
  const start = Date.now();

  // ═══ SSRF 防护: 统一走 validateUrl ═══
  const urlCheck = validateUrl(url);
  if (!urlCheck.valid) {
    return { success: false, url, content: '', contentLength: 0, elapsedMs: Date.now() - start, fetchQuality: 'blocked', error: urlCheck.error };
  }

  const maxChars = config.maxChars ?? 5000;
  const timeout = config.timeout ?? 15000;
  const maxPagesInput = config.maxPages ?? 1;
  const maxPages = maxPagesInput === 0 ? MAX_PAGES_HARD_LIMIT : Math.min(maxPagesInput, MAX_PAGES_HARD_LIMIT);

  if (!url || !/^https?:\/\//.test(url.trim())) {
    return {
      success: false, url,
      title: undefined, content: '', contentLength: 0, elapsedMs: 0,
      error: '无效的 URL，必须以 http:// 或 https:// 开头',
    };
  }

  const pages: Array<{ url: string; title: string; content: string }> = [];
  const visited = new Set<string>();
  let currentUrl = url.trim();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const normalized = normalizeUrl(currentUrl);
    if (visited.has(normalized)) break;
    visited.add(normalized);

    const pageResult = await fetchSinglePage(currentUrl, timeout, config.format ?? 'text', maxChars);
    if (!pageResult.success) {
      // 第一页失败→整体失败；后续页失败→停止遍历
      if (pageIndex === 0) {
        return {
          success: false, url: currentUrl,
          title: undefined, content: '', contentLength: 0,
          elapsedMs: Date.now() - start,
          error: pageResult.error ?? '获取失败',
        };
      }
      break;
    }

    pages.push({
      url: currentUrl,
      title: pageResult.title ?? currentUrl,
      content: pageResult.content,
    });

    // 检测下一页
    const nextUrl = detectNextPageUrl(pageResult.html, currentUrl);
    if (!nextUrl) break;
    currentUrl = nextUrl;
  }

  if (pages.length === 0) {
    return {
      success: false, url: url.trim(),
      title: undefined, content: '', contentLength: 0,
      elapsedMs: Date.now() - start,
      error: '未能获取任何页面内容',
    };
  }

  // 合并所有页面
  const combined = pages.map((p, i) => {
    const header = pages.length > 1
      ? `\n\n---\n## 📄 第 ${i + 1}/${pages.length} 页: ${p.title}\nURL: ${p.url}\n---\n\n`
      : '';
    return header + p.content;
  }).join('');

  const totalChars = combined.length;

  return {
    success: true,
    url: url.trim(),
    title: pages[0].title,
    content: combined,
    contentLength: totalChars,
    elapsedMs: Date.now() - start,
  };
}

/** 单页抓取 */
async function fetchSinglePage(
  url: string,
  timeout: number,
  format: string,
  maxChars: number,
): Promise<{ success: boolean; html: string; title?: string; content: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekCode/1.0; +https://github.com/deepseek-code)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    // 重定向后二次校验: 防止 302→内网
    if (res.url !== url) {
      const redirectCheck = validateUrl(res.url);
      if (!redirectCheck.valid) {
        return { success: false, html: '', content: '', error: `重定向目标被拦截: ${redirectCheck.error}` };
      }
    }

    if (!res.ok) {
      return { success: false, html: '', content: '', error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { success: false, html: '', content: '', error: `不支持的内容类型: ${contentType}` };
    }

    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHTML(titleMatch[1]).trim() : url;

    let content: string;
    if (format === 'markdown') {
      content = htmlToMarkdown(html);
    } else {
      content = extractTextContent(html);
    }

    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + `\n\n... (已截断，原文 ${content.length} 字符)`;
    }

    return { success: true, html, title, content };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false, html: '', content: '',
      error: message.includes('abort') ? `请求超时 (${timeout}ms)` : `获取失败: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 中检测下一页 URL */
function detectNextPageUrl(html: string, currentUrl: string): string | null {
  // 1. <link rel="next" href="..."> — HTML 标准分页
  const linkMatch = html.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
    ?? html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["'][^>]*\/?>/i);
  if (linkMatch) {
    return resolveUrl(linkMatch[1], currentUrl);
  }

  // 2. <a rel="next" href="...">
  const aRelMatch = html.match(/<a[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<a[^>]*href=["']([^"']+)["'][^>]*rel=["']next["'][^>]*>/i);
  if (aRelMatch) {
    return resolveUrl(aRelMatch[1], currentUrl);
  }

  // 3. 链接文本匹配: 下一页|Next|»|›|next page|后一页|下一章
  const linkTextRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const nextPatterns = /下一页|后一页|下一[页篇章节]|next\s*(page|chapter|section)?|»|›|→|&raquo;|&#8594;/i;
  let match;
  while ((match = linkTextRegex.exec(html)) !== null) {
    const href = match[1];
    const text = stripHTML(match[2]).trim();
    if (text.length <= 30 && nextPatterns.test(text)) {
      // 排除"上一页"（前一页/prev）
      if (/上一页|前一[页篇章节]|prev(ious)?|«|‹|←|&laquo;/.test(text)) continue;
      const resolved = resolveUrl(href, currentUrl);
      // 确保不是当前页 URL
      if (normalizeUrl(resolved) !== normalizeUrl(currentUrl)) {
        return resolved;
      }
    }
  }

  return null;
}

/** 解析相对 URL 为绝对 URL */
function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    // 简单拼接
    if (href.startsWith('/')) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${href}`;
    }
    return new URL(href, baseUrl).href;
  }
}

/** URL 标准化（去尾部斜杠、小写化 host）用于去重 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    u.pathname = path || '/';
    return u.href;
  } catch {
    return url.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 将 HTML 转为简化 Markdown
 */
function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    // 代码块
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // 标题
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    // 粗体/斜体
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
    .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
    // 链接
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // 列表项
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    // 段落
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    // 换行
    .replace(/<br\s*\/?>/gi, '\n')
    // 剩余标签
    .replace(/<[^>]*>/g, '');

  // 清理多余空行
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();

  return text;
}

/**
 * 将 WebSearchResult 格式化为模型可读文本
 */
export function formatWebSearchResult(result: WebSearchResult): string {
  if (!result.success) {
    return `❌ 网络搜索失败: ${result.error ?? '未知错误'}`;
  }

  if (result.results.length === 0) {
    return `🔍 未找到与 "${result.query}" 相关的结果。`;
  }

  const lines = [
    `🔍 搜索: "${result.query}" — ${result.totalEstimated} 条结果 (${(result.elapsedMs / 1000).toFixed(1)}s, ${result.source})`,
    '',
  ];

  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    lines.push(`**[${i + 1}] ${r.title}**`);
    lines.push(`    URL: ${r.url}`);
    if (r.snippet) lines.push(`    ${r.snippet.slice(0, 300)}`);
    if (r.content) {
      lines.push(`    ---`);
      lines.push(`    ${r.content.slice(0, 500)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
