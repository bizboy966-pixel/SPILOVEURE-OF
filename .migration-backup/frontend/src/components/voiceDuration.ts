export function formatVoiceDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export function elapsedVoiceSeconds(startedAtMs: number, stoppedAtMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(stoppedAtMs) || stoppedAtMs <= startedAtMs) return 0;
  return (stoppedAtMs - startedAtMs) / 1000;
}
