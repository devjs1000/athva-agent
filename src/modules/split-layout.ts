const MIN_SPLIT_LEFT_WIDTH = 20;
const MAX_SPLIT_LEFT_WIDTH = 80;
const DEFAULT_SPLIT_LEFT_WIDTH = 50;

export function clampSplitLeftWidth(
  value: number,
  fallback = DEFAULT_SPLIT_LEFT_WIDTH,
): number {
  const safeFallback = Number.isFinite(fallback) ? fallback : DEFAULT_SPLIT_LEFT_WIDTH;
  if (!Number.isFinite(value)) {
    return Math.min(MAX_SPLIT_LEFT_WIDTH, Math.max(MIN_SPLIT_LEFT_WIDTH, safeFallback));
  }
  return Math.min(MAX_SPLIT_LEFT_WIDTH, Math.max(MIN_SPLIT_LEFT_WIDTH, value));
}

export function computeSplitLeftWidthFromPointer(
  containerLeft: number,
  containerWidth: number,
  clientX: number,
  fallback = DEFAULT_SPLIT_LEFT_WIDTH,
): number {
  if (!Number.isFinite(containerLeft) || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return clampSplitLeftWidth(fallback);
  }

  const relativeX = clientX - containerLeft;
  const nextWidth = (relativeX / containerWidth) * 100;
  return clampSplitLeftWidth(nextWidth, fallback);
}
