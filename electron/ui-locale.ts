// Main-process UI locale snapshot without importing the Electron bootstrap.
// Utility modules and tests can read this state without starting main.ts.
let locale: "ko" | "en" = "en";

export function currentUiLocale(): "ko" | "en" {
  return locale;
}

export function setCurrentUiLocale(next: "ko" | "en"): void {
  locale = next;
}
