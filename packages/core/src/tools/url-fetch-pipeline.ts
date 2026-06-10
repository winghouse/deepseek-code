// ============================================================
// URL Fetch Pipeline — 受控网页抓取管线
// Target=url 时的专用执行器，不进入通用 Agent
//
// 安全边界:
// - validateUrl 前置 + 每次 redirect 后重新 validate
// - 不携带本地 Cookie / Authorization / 环境变量
// - 最大 3 次重定向
// - 静态 HTML 抓取 (非 JS 渲染)
// ============================================================

import type { ExternalResource, FetchQuality } from 'deepseek-code-shared';
import { validateUrl } from './web-search.js';
import { executeWebSearch } from './web-search.js';

// ═══ Types ═══

export interface UrlFetchResult {
  success: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  contentType?: string;
  text: string;
  links: string[];
  externalResource?: ExternalResource;
  summary?: string;
  /** 内容质量标记 */
  fetchQuality?: FetchQuality;
  error?: string;
  elapsedMs: number;
}

export interface UrlFetchOptions {
  maxChars?: number;
  timeout?: number;
  maxRedirects?: number;
  flashClient?: { chat(prompt: string): Promise<string> };
  onProgress?: (step: string) => void;
}

/** 外部资源缓存 TTL (10 分钟) */
const CACHE_TTL_MS = 10 * 60 * 1000;

// ═══ Pipeline ═══

/** 已有缓存中找到未过期的 */
const _cache = new Map<string, ExternalResource>();

export async function runUrlFetchPipeline(
  url: string,
  options: UrlFetchOptions = {},
): Promise<UrlFetchResult> {
  const start = Date.now();
  const maxChars = options.maxChars ?? 10000;
  const timeout = options.timeout ?? 15000;
  const maxRedirects = options.maxRedirects ?? 3;
  const { onProgress } = options;
  const tick = () => new Promise(r => setTimeout(r, 0));

  // Step 1: Validate initial URL
  onProgress?.('🔒 验证 URL...');
  await tick();
  const validation = validateUrl(url);
  if (!validation.valid) {
    return makeError(url, validation.error ?? 'URL 无效', start);
  }

  // Step 2: 检查缓存
  const cached = _cache.get(validation.sanitizedUrl);
  if (cached && cached.expiresAt && new Date(cached.expiresAt) > new Date()) {
    return makeCached(cached, start);
  }

  // Step 3: Fetch
  onProgress?.('🌐 抓取网页...');
  await tick();
  const fetchResult = await fetchWithRedirectValidation(
    validation.sanitizedUrl, maxRedirects, timeout, maxChars, options);

  // Step 3b: 直连失败时，尝试通过搜索引擎获取页面信息
  if (!fetchResult.success) {
    const searchResult = await searchFallbackForUrl(validation.sanitizedUrl, options);
    if (searchResult) return searchResult;
    return fetchResult; // 搜索降级也失败，返回原始错误
  }

  // Step 4: 评估内容质量，质量低时通过搜索补强
  const quality = assessQuality(fetchResult.text, fetchResult.contentType);
  let enhancedText = fetchResult.text;
  if (quality === 'empty' || quality === 'partial') {
    const searchEnhancement = await searchFallbackForUrl(validation.sanitizedUrl, options);
    if (searchEnhancement) {
      enhancedText = [
        fetchResult.text,
        '',
        '---',
        `⚠️ 页面可能是 JS 渲染的 SPA，静态 HTML 内容有限。以下是搜索引擎补充信息:`,
        '',
        searchEnhancement.text,
      ].join('\n');
    }
  }

  // Step 5: 构建 ExternalResource (带 TTL)
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
  const externalResource: ExternalResource = {
    url: validation.sanitizedUrl,
    finalUrl: fetchResult.finalUrl,
    title: fetchResult.title,
    textHash: simpleHash(enhancedText.slice(0, 1000)),
    fetchedAt: new Date().toISOString(),
    expiresAt,
    fetchQuality: quality,
  };
  _cache.set(validation.sanitizedUrl, externalResource);

  // Step 6: 可选摘要
  let summary: string | undefined;
  if (options.flashClient && fetchResult.text.length > 0) {
    try {
      const prompt = `用 2-3 句中文总结这个网页的主要内容，不要超过 200 字：\n\n标题: ${fetchResult.title ?? '未知'}\n\n内容: ${fetchResult.text.slice(0, 3000)}`;
      summary = await options.flashClient.chat(prompt);
      externalResource.summary = summary;
    } catch { /* ignore */ }
  }

  return {
    success: true,
    url: validation.sanitizedUrl,
    finalUrl: fetchResult.finalUrl,
    title: fetchResult.title,
    contentType: fetchResult.contentType,
    text: enhancedText,
    links: fetchResult.links,
    externalResource,
    summary,
    fetchQuality: quality,
    elapsedMs: Date.now() - start,
  };
}

// ═══ Redirect-aware fetch ═══

/** 手动处理 redirect，每次重新 validate 目标 URL */
async function fetchWithRedirectValidation(
  url: string,
  maxRedirects: number,
  timeout: number,
  maxChars: number,
  options: UrlFetchOptions,
): Promise<UrlFetchResult> {
  let currentUrl = url;
  const visited = new Set<string>();
  visited.add(currentUrl);

  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          // 不携带任何本地凭证、Cookie、Authorization
          'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekCode/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        signal: controller.signal,
        redirect: 'manual',  // 手动处理，确保每次 validate
      });

      // 检查是否 redirect
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          return makeError(url, `HTTP ${res.status} 但没有 Location 头`, Date.now());
        }

        // 解析 redirect URL (可能是相对路径)
        const redirectUrl = new URL(location, currentUrl).href;

        // 每次 redirect 重新 validate
        const reValidated = validateUrl(redirectUrl);
        if (!reValidated.valid) {
          return makeError(url, `重定向目标被拒绝: ${reValidated.error} (${redirectUrl.slice(0, 60)})`, Date.now());
        }

        // 防循环
        if (visited.has(reValidated.sanitizedUrl)) {
          return makeError(url, '检测到重定向循环', Date.now());
        }
        visited.add(reValidated.sanitizedUrl);

        currentUrl = reValidated.sanitizedUrl;
        continue;
      }

      // 非 redirect → 读取内容
      clearTimeout(timer);

      if (!res.ok) {
        return makeError(url, `HTTP ${res.status}`, Date.now());
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return {
          success: false, url,
          text: '', links: [],
          fetchQuality: 'unsupported_content_type',
          error: `不支持的内容类型: ${contentType}`,
          elapsedMs: 0,
        };
      }

      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? stripHTML(titleMatch[1]).trim() : url;

      let text: string;
      if (options.flashClient) {
        text = htmlToMarkdown(html);
      } else {
        text = stripHTML(html).replace(/\n{3,}/g, '\n\n').trim();
      }

      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n... (已截断，原文 ${text.length} 字符)`;
      }

      const links = extractLinksFromText(text);

      return {
        success: true,
        url,
        finalUrl: currentUrl,
        title,
        contentType,
        text,
        links,
        fetchQuality: assessQuality(text, contentType),
        elapsedMs: 0,
      };
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort') || msg.includes('AbortError')) {
        return makeError(url, `请求超时 (${timeout}ms)`, Date.now());
      }
      return makeError(url, `请求失败: ${msg.slice(0, 100)}`, Date.now());
    }
  }

  return makeError(url, `超过最大重定向次数 (${maxRedirects})`, Date.now());
}

// ═══ Quality Assessment ═══

function assessQuality(text: string, _contentType?: string): FetchQuality {
  if (!text || text.trim().length === 0) return 'empty';
  if (text.includes('Just a moment...') && text.includes('enable JavaScript')) return 'blocked';

  // 去除常见的 JS/CSS 噪音后评估可读内容比
  const cleanText = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/[{}\[\]();=>|&!]/g, '')
    .replace(/\b(function|var|let|const|window|document|export|import|require|return|this|new|true|false|null|undefined)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanText.length < 80) return 'empty';
  if (cleanText.length < 200) return 'partial';

  // 计算可读字符比例（排除符号和关键词后）
  const readableRatio = cleanText.length / Math.max(text.length, 1);
  if (readableRatio < 0.15) return 'empty';   // 几乎全是代码
  if (readableRatio < 0.3) return 'partial';   // 代码为主，少量文字

  return 'complete';
}

// ═══ Helpers ═══

function makeError(url: string, error: string, start: number): UrlFetchResult {
  return {
    success: false, url,
    text: '', links: [],
    fetchQuality: 'blocked',
    error,
    elapsedMs: Date.now() - start,
  };
}

function makeCached(cached: ExternalResource, _start: number): UrlFetchResult {
  return {
    success: true,
    url: cached.url,
    finalUrl: cached.finalUrl,
    title: cached.title,
    text: cached.summary ?? '',
    links: [],
    externalResource: cached,
    fetchQuality: cached.fetchQuality ?? 'complete',
    elapsedMs: 0,
  };
}

function extractLinksFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = text.match(urlRegex) ?? [];
  return [...new Set(matches)].slice(0, 50);
}

// ═══ 搜索降级: 直连失败时通过搜索引擎获取页面信息 ═══

/**
 * 当直连 URL 失败时，尝试通过搜索引擎获取页面摘要
 * 策略:
 * 1. 搜索完整 URL → 找搜索引擎缓存的描述
 * 2. 搜索 site:domain → 找该站的主要描述
 */
async function searchFallbackForUrl(
  url: string,
  options: UrlFetchOptions,
): Promise<UrlFetchResult | null> {
  try {
    const hostname = new URL(url).hostname;

    // 先尝试精确搜索完整 URL
    const exactSearch = await executeWebSearch(url, { maxResults: 3 });
    if (exactSearch.success && exactSearch.results.length > 0) {
      const combined = exactSearch.results
        .map((r) => `**${r.title}**\n${r.snippet}\n${r.url}`)
        .join('\n\n');

      const quality: FetchQuality = combined.length > 200 ? 'partial' : 'empty';

      return {
        success: true,
        url,
        title: exactSearch.results[0].title,
        text: [
          `⚠️ 无法直连 ${hostname}，以下内容来自搜索引擎 (${exactSearch.source}):`,
          '',
          combined,
          '',
          `---`,
          `💡 提示: 该网站可能在你所在地区不可直连。你可以粘贴网页内容给我分析。`,
        ].join('\n'),
        links: exactSearch.results.map((r) => r.url),
        fetchQuality: quality,
        elapsedMs: 0,
      };
    }

    // 精确匹配失败，搜索站点名
    const siteSearch = await executeWebSearch(`${hostname} site:${hostname}`, { maxResults: 3 });
    if (siteSearch.success && siteSearch.results.length > 0) {
      const combined = siteSearch.results
        .map((r) => `**${r.title}**\n${r.snippet}\n${r.url}`)
        .join('\n\n');

      return {
        success: true,
        url,
        title: `${hostname} 搜索摘要`,
        text: [
          `⚠️ 无法直连 ${hostname}，以下是搜索引擎找到的相关信息:`,
          '',
          combined,
        ].join('\n'),
        links: siteSearch.results.map((r) => r.url),
        fetchQuality: 'partial',
        elapsedMs: 0,
      };
    }
  } catch { /* 搜索降级也失败 */ }

  return null;
}

function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

function stripHTML(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 格式化 UrlFetchResult 为模型可读文本
 * 对应 Codex 的 WebSearch result formatting
 */
export function formatUrlFetchResult(result: UrlFetchResult): string {
  if (!result.success) {
    return `❌ 无法读取网页: ${result.error ?? '未知错误'}\n\n> 当前 CLI 不能直接读取网页内容。请粘贴网页文本，或检查 URL 是否正确。`;
  }

  const lines = [
    `📄 **${result.title ?? result.url}**`,
    `URL: ${result.url}`,
    ...(result.finalUrl && result.finalUrl !== result.url ? [`重定向至: ${result.finalUrl}`] : []),
    '',
    result.text,
    '',
  ];

  if (result.summary) {
    lines.push(`---\n📝 **AI 摘要:** ${result.summary}`);
  }

  if (result.links.length > 0) {
    lines.push(`\n📎 **页面链接 (${result.links.length}):**`);
    for (const link of result.links.slice(0, 10)) {
      lines.push(`  - ${link}`);
    }
    if (result.links.length > 10) lines.push(`  ... 共 ${result.links.length} 个链接`);
  }

  lines.push(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s`);

  return lines.join('\n');
}
