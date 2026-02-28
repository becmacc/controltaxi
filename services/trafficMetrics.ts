export const clampTrafficIndex = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
};

export const computeTrafficIndex = (durationInTrafficMin: number, baselineDurationMin: number): number => {
  if (!Number.isFinite(durationInTrafficMin) || !Number.isFinite(baselineDurationMin) || baselineDurationMin <= 0) {
    return 0;
  }

  const durationRatio = durationInTrafficMin / baselineDurationMin;
  const normalized = ((Math.min(Math.max(durationRatio, 1), 2.5) - 1) / 1.5) * 100;
  return clampTrafficIndex(normalized);
};
