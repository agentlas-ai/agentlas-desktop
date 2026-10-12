/**
 * What every model is told to do about an outside action whose result was never confirmed.
 *
 * The look that used to settle such an action was retired on 2026-10-05 (electron/long-run/effect-observation.ts):
 * no reviewer exists any more. Prompts that still said "never redo it, the observation controller will check"
 * therefore parked a Goal forever. The Yotube room's voice step sat that way for a day on two interrupted turns that
 * had never reached ElevenLabs at all (media_operations 0 rows). One shared statement keeps the Goal resume prompt,
 * the AGI unblocker and the tactic guidance saying the same thing.
 */
export const UNCERTAIN_EFFECT_POLICY =
  "An earlier outside action ended without a confirmed result. No other reviewer will settle it, so do not wait for one " +
  "and do not stop the goal. Check the current state yourself first: a file or output it should have produced, a receipt, " +
  "the sent or posted item. If the result is there, use it. If it is not there, or you cannot tell and the action is cheap " +
  "to redo (generating, rendering, converting or downloading something, text-to-speech, a read or a search), do it again now. " +
  "Only for an action that cannot be taken back and cannot be checked (a message sent, a post published, a payment) do not " +
  "repeat it blindly: read the destination first, and if it still cannot be told, carry on with other work and say so in the report.";
