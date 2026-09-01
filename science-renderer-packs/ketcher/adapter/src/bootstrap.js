// Ketcher's bundled compatibility layer still reads the historical `global`
// browser alias during module initialization. Establish the alias before the
// editor graph is evaluated without exposing Node or any preload capability.
globalThis.global = globalThis;

void import("./main.jsx");
