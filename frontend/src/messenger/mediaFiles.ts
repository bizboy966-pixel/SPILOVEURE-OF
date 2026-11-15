/** Mobile file pickers may omit MIME types or return application/octet-stream. */
export const CHAT_FILE_LIMIT = 20 * 1024 * 1024;

const mediaTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  "3gp": "video/3gpp", "3g2": "video/3gpp2",
};

export function inferredMediaType(file: Pick<File, "name" | "type">): string {
  const declared = (file.type || "").split(";")[0].trim().toLowerCase();
  const suffix = file.name.split(".").pop()?.toLowerCase() || "";
  if (!declared || declared === "application/octet-stream") return mediaTypes[suffix] || declared;
  if (suffix === "m4v" && declared.startsWith("video/")) return "video/mp4";
  return declared;
}

export function normalizeMediaFile(file: File): File {
  const type = inferredMediaType(file);
  return type && type !== file.type
    ? new File([file], file.name, { type, lastModified: file.lastModified })
    : file;
}

export function validateChatFiles(files: File[]): void {
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name} est vide. Sélectionnez un autre fichier.`);
    if (file.size > CHAT_FILE_LIMIT) throw new Error(`${file.name} dépasse la limite de 20 Mo par fichier.`);
  }
}
