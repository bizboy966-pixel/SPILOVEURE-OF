type SearchableCountry = { code: string; name: string; dial: string };

const fullNames: Record<string, string> = {
  CD: "République démocratique du Congo",
  CG: "République du Congo",
  CF: "République centrafricaine",
};

export function countryDisplayName(country: SearchableCountry): string {
  return fullNames[country.code] || country.name;
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
