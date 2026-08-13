/**
 * Conservative classifier for an explicit request to create or alter a
 * scheduled automation. It deliberately does not treat generic words such as
 * "every" or "register" as automation intent: ordinary writing tasks use
 * those terms frequently (for example, "every named character" and
 * "register a canon decision").
 */
export function isAutomationSetupRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const automationSubject = /자동화|오토메이션|예약|리마인드|반복\s*(?:작업|실행)?|정기\s*(?:작업|실행)?|\b(?:automation|automate|scheduled|recurring|reminder|cron)\b/u;
  const setupVerb = /걸어|걸자|설정|등록|만들|추가|켜줘|해줘|해라|해놔|\b(?:set\s*up|create|add|register|turn\s+on|remind)\b/u;
  const explicitCadence = /(?:매일|매주|매월|매시간|매\s*(?:아침|저녁|분기)|\b(?:daily|weekly|monthly|hourly|every\s+(?:day|week|month|morning|evening|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(?:day|week|month))\b)/u;
  return (automationSubject.test(text) && setupVerb.test(text))
    || (explicitCadence.test(text) && setupVerb.test(text));
}
