export const UI_TAG_MAX_CHARS = 16;
export const UI_LOCATION_MAX_CHARS = 52;

export const truncateUiText = (value: string, maxLength: number): string => {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const safeMaxLength = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : UI_TAG_MAX_CHARS;
  return normalized.length > safeMaxLength
    ? `${normalized.slice(0, Math.max(1, safeMaxLength - 1))}…`
    : normalized;
};
