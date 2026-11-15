export type NotificationSoundSettings = {
  enabled: boolean;
  sound_enabled: boolean;
  preview: boolean;
  sound: "default" | "chime" | "bell" | "soft" | "bright" | "bubble" | "pulse" | "marimba" | "custom";
  inherit?: boolean;
};

export type BuiltInNotificationSound = Exclude<NotificationSoundSettings["sound"], "custom">;
export const BUILT_IN_NOTIFICATION_SOUNDS: BuiltInNotificationSound[] = [
  "default", "chime", "bell", "soft", "bright", "bubble", "pulse", "marimba",
];

const DB_NAME = "spiloveure-notification-sounds";
const STORE_NAME = "sounds";
export const MAX_NOTIFICATION_SOUND_BYTES = 4 * 1024 * 1024;
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext || audioContext.state === "closed") audioContext = new Ctor();
  return audioContext;
}

function requireAudioContext(): AudioContext {
  const context = getAudioContext();
  if (!context) throw new Error("La lecture audio n’est pas disponible dans ce navigateur. Ouvrez le Chat dans Chrome, Safari ou Firefox.");
  return context;
}

async function readyAudio(context: AudioContext): Promise<void> {
  const isRunning = () => context.state === "running";
  if (isRunning()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Le navigateur bloque le son. Touchez à nouveau « Tester le son » dans l’onglet du Chat.")), 4000);
      }),
    ]);
    if (!isRunning()) throw new Error("Le son est suspendu. Touchez à nouveau « Tester le son ».");
  } finally { clearTimeout(timer); }
}

export function encodeNotificationExcerpt(buffer: AudioBuffer): { blob: Blob; duration: number } {
  const channels = Math.min(2, buffer.numberOfChannels);
  if (!channels || !buffer.length || !buffer.sampleRate) throw new Error("Le fichier audio est vide.");
  const frames = Math.min(buffer.length, Math.floor((MAX_NOTIFICATION_SOUND_BYTES - 44) / (channels * 2)));
  const dataBytes = frames * channels * 2;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, dataBytes, true);
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  const fadeFrames = Math.min(frames, Math.floor(buffer.sampleRate * 0.02));
  for (let frame = 0; frame < frames; frame++) {
    const fade = frame >= frames - fadeFrames ? (frames - frame - 1) / Math.max(1, fadeFrames) : 1;
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, samples[channel][frame])) * fade;
      view.setInt16(44 + (frame * channels + channel) * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
  }
  return { blob: new Blob([bytes], { type: "audio/wav" }), duration: frames / buffer.sampleRate };
}

export async function prepareNotificationSound(file: Blob): Promise<{ blob: Blob; duration: number; trimmed: boolean }> {
  if (!file.size) throw new Error("Le fichier audio est vide.");
  const context = requireAudioContext();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error("Ce format audio ne peut pas être lu. Choisissez un fichier MP3, WAV ou un autre format pris en charge par ce navigateur."); }
  if (!decoded.length || !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error("Le fichier audio est vide ou invalide.");
  if (file.size <= MAX_NOTIFICATION_SOUND_BYTES) return { blob: file, duration: decoded.duration, trimmed: false };
  return { ...encodeNotificationExcerpt(decoded), trimmed: true };
}

export function unlockNotificationAudio(): void {
  try {
    const context = getAudioContext();
    if (context?.state === "suspended") void context.resume().catch(() => undefined);
  } catch {
    // Browsers may reject audio activation; playback reports that to the caller.
  }
}

function openSoundDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Le stockage audio local n’est pas disponible dans ce navigateur."));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Ouverture du stockage audio impossible."));
  });
}

function soundKey(userId: string, scope: string): string {
  return `${userId}:${scope}`;
}

export async function storeCustomNotificationSound(userId: string, scope: string, file: Blob, name: string): Promise<void> {
  if (file.size > MAX_NOTIFICATION_SOUND_BYTES) throw new Error("Le son doit être découpé à 4 Mo maximum avant l’enregistrement.");
  const db = await openSoundDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        key: soundKey(userId, scope),
        file,
        name: name.slice(0, 120),
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Enregistrement du son impossible."));
      transaction.onabort = () => reject(transaction.error || new Error("Enregistrement du son impossible."));
    });
  } finally {
    db.close();
  }
}

export async function getCustomNotificationSound(userId: string, scope: string): Promise<{ file: Blob; name: string } | null> {
  const db = await openSoundDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(soundKey(userId, scope));
      request.onsuccess = () => {
        const row = request.result;
        resolve(row?.file instanceof Blob ? { file: row.file, name: String(row.name || "Son personnalisé") } : null);
      };
      request.onerror = () => reject(request.error || new Error("Lecture du son impossible."));
    });
  } finally {
    db.close();
  }
}

export async function removeCustomNotificationSound(userId: string, scope: string): Promise<void> {
  const db = await openSoundDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(soundKey(userId, scope));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Suppression du son impossible."));
    });
  } finally {
    db.close();
  }
}

function playOscillator(kind: BuiltInNotificationSound): Promise<void> {
  return new Promise((resolve, reject) => {
    const context = getAudioContext();
    if (!context) {
      reject(new Error("La lecture audio n’est pas prise en charge par ce navigateur."));
      return;
    }
    const start = () => {
      try {
        const now = context.currentTime;
        const patterns: Record<BuiltInNotificationSound, { notes: number[]; wave: OscillatorType; interval: number }> = {
          default: { notes: [740], wave: "triangle", interval: 0.12 },
          chime: { notes: [659.25, 880], wave: "triangle", interval: 0.12 },
          bell: { notes: [880, 1174.66], wave: "sine", interval: 0.12 },
          soft: { notes: [523.25], wave: "sine", interval: 0.12 },
          bright: { notes: [784, 1046.5, 1318.5], wave: "triangle", interval: 0.1 },
          bubble: { notes: [587.33, 783.99], wave: "sine", interval: 0.16 },
          pulse: { notes: [880, 659.25, 880], wave: "square", interval: 0.09 },
          marimba: { notes: [523.25, 659.25, 783.99], wave: "sine", interval: 0.14 },
        };
        const { notes, wave, interval } = patterns[kind];
        notes.forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = wave;
          oscillator.frequency.setValueAtTime(frequency, now + index * interval);
          gain.gain.setValueAtTime(0.0001, now + index * interval);
          gain.gain.exponentialRampToValueAtTime(0.06, now + index * interval + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + index * interval + 0.28);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(now + index * interval);
          oscillator.stop(now + index * interval + 0.3);
        });
        window.setTimeout(resolve, notes.length * interval * 1000 + 340);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Lecture du son impossible."));
      }
    };
    readyAudio(context).then(start).catch(reject);
  });
}

async function playBlob(blob: Blob, context: AudioContext): Promise<void> {
  let buffer: AudioBuffer;
  try { buffer = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error("Le son importé ne peut pas être décodé sur cet appareil. Importez un fichier MP3 ou WAV."); }
  if (!buffer.duration) throw new Error("Le son importé est vide.");
  return new Promise((resolve, reject) => {
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => { source.disconnect(); resolve(); };
      source.start(0, 0, Math.min(6, buffer.duration));
    } catch { reject(new Error("Impossible de démarrer la lecture du son importé.")); }
  });
}

export async function playNotificationSound(userId: string, scope: string, settings: NotificationSoundSettings): Promise<void> {
  if (!settings.enabled || !settings.sound_enabled) return;
  // Resume while still in the click/touch event, BEFORE the IndexedDB await.
  const context = requireAudioContext();
  const ready = readyAudio(context);
  if (settings.sound === "custom") {
    await ready;
    const custom = await getCustomNotificationSound(userId, scope);
    if (!custom) throw new Error("Le son personnalisé n’est pas disponible sur cet appareil. Importez-le à nouveau ici.");
    await playBlob(custom.file, context);
    return;
  }
  await ready;
  await playOscillator(settings.sound === "custom" ? "default" : settings.sound);
}
