/** Digits as comparable tokens: "R1 500 000" and "1,500,000" are the same number. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/[ ,]/g, ""));
}

/** Figures in `text` that appear nowhere in `source`: an invented year, count, grade, standard or amount. */
export function ungroundedNumbers(text: string, source: string): string[] {
  const known = new Set(numbersIn(source));
  return [...new Set(numbersIn(text).filter((n) => !known.has(n)))];
}
