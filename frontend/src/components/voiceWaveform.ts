/** Fixed-size peaks from real samples; normalize quiet recordings for display. */
export function voiceWaveform(samples: Float32Array, count = 36): number[] {
  const peaks = Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * samples.length / count);
    const end = Math.floor((index + 1) * samples.length / count);
    const step = Math.max(1, Math.floor((end - start) / 256));
    let peak = 0;
    for (let sample = start; sample < end; sample += step) {
      peak = Math.max(peak, Math.abs(samples[sample] || 0));
    }
    return peak;
  });
  const maximum = Math.max(...peaks);
  return peaks.map(peak => maximum > 0 ? Math.round(3 + peak / maximum * 20) : 3);
}
