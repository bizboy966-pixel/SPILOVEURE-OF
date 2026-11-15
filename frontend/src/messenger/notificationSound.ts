export type NotificationSoundSettings = {
  enabled: boolean;
  sound_enabled: boolean;
  preview: boolean;
  sound: "default" | "chime" | "bell" | "custom";
  inherit?: boolean;
};

const DB_NAME = "spiloveure-notification-sounds";
const STORE_NAME = "sounds";
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) audioContext = new Ctor();
  return audioContext;
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

function playOscillator(kind: "chime" | "bell" | "default"): Promise<void> {
  return new Promise((resolve, reject) => {
    const context = getAudioContext();
    if (!context) {
      reject(new Error("La lecture audio n’est pas prise en charge par ce navigateur."));
      return;
    }
    const start = () => {
      try {
        const now = context.currentTime;
        const notes = kind === "bell" ? [880, 1174.66] : kind === "chime" ? [659.25, 880] : [740];
        notes.forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = kind === "bell" ? "sine" : "triangle";
          oscillator.frequency.setValueAtTime(frequency, now + index * 0.12);
          gain.gain.setValueAtTime(0.0001, now + index * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.075, now + index * 0.12 + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.34);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(now + index * 0.12);
          oscillator.stop(now + index * 0.12 + 0.36);
        });
        window.setTimeout(resolve, notes.length * 120 + 390);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Lecture du son impossible."));
      }
    };
    if (context.state === "suspended") {
      context.resume().then(start).catch(() => reject(new Error("Le navigateur bloque la lecture audio. Touchez d’abord « Tester le son ».")));
    } else start();
  });
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof Audio === "undefined" || typeof URL === "undefined") {
      reject(new Error("La lecture audio n’est pas disponible dans cet environnement."));
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let settled = false;
    const timer = setTimeout(() => finish(), 6000);
    const cleanup = () => {
      clearTimeout(timer);
      audio.pause();
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error("Ce son personnalisé ne peut pas être lu sur cet appareil."));
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.play().catch(() => finish(new Error("Le navigateur bloque la lecture audio. Touchez d’abord « Tester le son ».")));
  });
}

export async function playNotificationSound(userId: string, scope: string, settings: NotificationSoundSettings): Promise<void> {
  if (!settings.enabled || !settings.sound_enabled) return;
  if (settings.sound === "custom") {
    const custom = await getCustomNotificationSound(userId, scope);
    if (!custom) throw new Error("Le son personnalisé n’est pas disponible sur cet appareil. Importez-le à nouveau ici.");
    await playBlob(custom.file);
    return;
  }
  await playOscillator(settings.sound === "chime" || settings.sound === "bell" ? settings.sound : "default");
}
