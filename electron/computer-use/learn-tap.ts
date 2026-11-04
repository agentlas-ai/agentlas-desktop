// The one seam between the computer-use control server and Reach's learning. The control server calls these for every observation and action; with no sink
// installed (the default, and whenever the owner's Reach switch is off) every call is a no-op and nothing is computed. No Electron import.
//
// What crosses: the observed controls' role, caption, value (only to notice a change) and parent; the kind of action and which control it hit.
// What never crosses: typed text, key text, pixel positions, window contents beyond the observed controls' captions.

export interface LearnTapElement { index: number; role?: string; label?: string; value?: string; parent?: number }
export interface LearnTapObservation { app: string; observationId: string; elements: LearnTapElement[]; at: number }
export interface LearnTapAction { app: string | null; action: string; observationId?: string; elementIndex?: number; operation?: string; key?: string; modifiers?: readonly string[]; ok: boolean; at: number }
export interface LearnTapSink { active(): boolean; observed(observation: LearnTapObservation): void; acted(action: LearnTapAction): void }

let sink: LearnTapSink | null = null;

export function setLearnTap(next: LearnTapSink | null): void { sink = next; }

export const learnTap = {
  // true only when a sink is installed AND the owner allows learning right now; the caller builds the (copied) observation only then
  active(): boolean { try { return sink?.active() === true; } catch { return false; } },
  observed(observation: LearnTapObservation): void { try { sink?.observed(observation); } catch { /* learning must never disturb the agent's work */ } },
  acted(action: LearnTapAction): void { try { sink?.acted(action); } catch { /* same */ } },
};
