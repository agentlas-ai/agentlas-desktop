/**
 * The colours a manuscript uses to say something about its own state.
 *
 * Not typography, not layout, not the paper's look -- only the handful of colours that carry
 * MEANING: this asset is not here, this reference did not resolve, this is a link. Those meanings
 * are the same whether the manuscript is read as HTML on screen, printed as PDF, or opened in Word,
 * so the colour has to be the same too, and it has to be decided once.
 *
 * It was not. The paper stylesheet in render-html.ts and the run styles in render-docx.ts each kept
 * their own copy, and when the screen vocabulary moved to a neutral ramp only the stylesheet
 * followed: the DOCX renderer still wrote `9A5A4C`, the warm brown that had already been retired.
 * A reader opening the same manuscript in two formats saw two different colours for one fact.
 *
 * Values are stored without the leading `#` because OOXML wants them that way; `css()` adds it back.
 * The values themselves belong to whoever owns the product's visual vocabulary -- this file is the
 * place to change them, and changing them here changes every surface at once.
 */
export const SCIENCE_MANUSCRIPT_COLOURS = Object.freeze({
  /**
   * Something that has not been produced. Deliberately NOT the alert colour: a figure that has not
   * been captured yet is not a figure that failed, and the product's whole vocabulary rests on that
   * distinction.
   */
  absence: "6A6A73",
  /** A step that ran and did not hold. Reserved for that; never used for an absence. */
  failure: "B3261E",
  /** A hyperlink, in the convention every word processor already uses. */
  link: "1F4E79",
});

export function manuscriptColourCss(name: keyof typeof SCIENCE_MANUSCRIPT_COLOURS): string {
  return `#${SCIENCE_MANUSCRIPT_COLOURS[name]}`;
}
