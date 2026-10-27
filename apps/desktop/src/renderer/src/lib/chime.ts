let ctx: AudioContext | null = null;

/** Signal sonore discret, synthétisé (aucun fichier audio) : deux notes, plus graves pour une erreur. */
export function playChime(level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  try {
    ctx ??= new AudioContext();
    const notes = level === 'error' ? [440, 330] : level === 'warning' ? [523, 440] : [660, 880];
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const start = ctx!.currentTime + i * 0.12;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
  } catch {
    /* audio indisponible : notification silencieuse */
  }
}
