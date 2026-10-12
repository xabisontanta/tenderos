// @ts-check
// TenderOS browser helper: the one error type whose message is written for the
// person using the helper. No chrome APIs here, so unit tests can import it.

/**
 * What went wrong, for code that has to decide what to do next (the message is for people).
 * @typedef {"unauthorized"|"not_found"|"rate_limited"|"network"|"server"|"conflict"|"unprocessable"|"invalid_response"|"forbidden"} HelperErrorCode
 */

/** An error whose message is written for the person using the helper. */
export class HelperError extends Error {
  /**
   * @param {string} message
   * @param {HelperErrorCode} [code]
   */
  constructor(message, code) {
    super(message);
    this.name = "HelperError";
    /** @type {HelperErrorCode | undefined} */
    this.code = code;
  }
}
