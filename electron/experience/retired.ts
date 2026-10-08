/** Compatibility readers retain private history; active chip operations are retired. */
export function experienceChipsRetired(): never {
  const error = new Error("experience_chips_retired: Review memory as agent file changes in Manage Agent.") as Error & { code: string };
  error.code = "experience_chips_retired";
  throw error;
}
