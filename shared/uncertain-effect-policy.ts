/**
 * What every model is told to do when an earlier turn ended early (interrupted or failed) and an outside action of
 * it may not have finished. The host records only the attempt's state; whether anything happened outside is the
 * model's own check (owner 2026-10-12). One shared statement keeps the Goal resume prompt, the AGI unblocker and the
 * tactic guidance saying the same thing.
 */
export const UNCERTAIN_EFFECT_POLICY =
  "An earlier turn ended early, so an outside action of it may not have finished. Nobody else will check it, so do not wait for a reviewer " +
  "and do not stop the goal. Check the current state yourself first: a file or output it should have produced, a receipt, " +
  "the sent or posted item. If the result is there, use it. If it is not there, or you cannot tell and the action is cheap " +
  "to redo (generating, rendering, converting or downloading something, text-to-speech, a read or a search), do it again now. " +
  "Only for an action that cannot be taken back and cannot be checked (a message sent, a post published, a payment) do not " +
  "repeat it blindly: read the destination first, and if it still cannot be told, carry on with other work and say so in the report.";
