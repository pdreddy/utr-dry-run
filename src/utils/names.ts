export function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

export function namesEqual(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
