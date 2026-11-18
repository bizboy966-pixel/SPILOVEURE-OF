export function registrationPasswordError(password: string, confirmation: string): string | null {
  const characters = Array.from(password);
  if (characters.length < 8) return "Le mot de passe doit contenir au moins 8 caractères.";
  // Do not depend on TextEncoder, which is not available on every native runtime.
  const bytes = characters.reduce((total, character) => {
    const point = character.codePointAt(0)!;
    return total + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
  if (bytes > 72) return "Le mot de passe ne doit pas dépasser 72 octets.";
  if (password !== confirmation) return "Les mots de passe ne correspondent pas.";
  return null;
}
