// ============================================================
// resolvePendingChoice — 短回复序号解析（纯函数，可单测）
// 支持: "1" | "01" | "一" | "第一项" | "第二项" | "五"
// 越界/不识别的输入返回 null
// ============================================================

const CN_DIGIT_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
};

export interface PendingChoice {
  id: string;
  label: string;
}

export interface ResolvedChoice {
  label: string;
  index: number;
}

/**
 * 将用户短回复解析为待选项。
 * 归一化策略：先剥离 "第...项" 包装，再按数字/中文序号查表。
 *
 * @returns 匹配结果，越界或无法识别返回 null
 */
export function resolvePendingChoice(
  input: string,
  choices: PendingChoice[],
): ResolvedChoice | null {
  if (!choices || choices.length === 0) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // 归一化: 剥离 "第...项" 包装 → 纯序号
  const normalized = trimmed.replace(/^第/, '').replace(/项$/, '');

  // 解析序号
  let n: number;
  if (/^\d+$/.test(normalized)) {
    n = parseInt(normalized, 10);
  } else if (CN_DIGIT_MAP[normalized] !== undefined) {
    n = CN_DIGIT_MAP[normalized];
  } else {
    return null;
  }

  const idx = n - 1;
  if (idx < 0 || idx >= choices.length) return null;

  return { label: choices[idx].label, index: idx };
}
