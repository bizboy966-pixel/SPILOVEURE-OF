type SearchableCountry = { code: string; name: string; dial: string };

const fullNames: Record<string, string> = {
  CD: "République démocratique du Congo",
  CG: "République du Congo",
  CF: "République centrafricaine",
};

export function localizedCountryName(
  code: string,
  fallback: string,
  language: "fr" | "en" = "fr",
): string {
  if (language === "fr" && fullNames[code]) return fullNames[code];
  try {
    const locale = language === "en" ? "en" : "fr";
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) || fallback;
  } catch {
    return fallback;
  }
}

export function countryDisplayName(
  country: SearchableCountry,
  language: "fr" | "en" = "fr",
): string {
  return localizedCountryName(country.code, country.name, language);
}

function normalizedName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’ʼ-]/g, " ").replace(/\s+/g, " ").trim();
}

export function matchesCountry(country: SearchableCountry, query: string): boolean {
  const value = query.trim();
  if (!value) return true;
  if (/^[+\d\s().-]+$/.test(value) && /\d/.test(value)) {
    const digits = value.replace(/\D/g, "").replace(/^00/, "");
    return !!digits && country.dial.replace(/\D/g, "").startsWith(digits);
  }
  const names = normalizedName(`${countryDisplayName(country)} ${country.name} ${country.code}`);
  return normalizedName(value).split(" ").every(word => names.includes(word));
}
