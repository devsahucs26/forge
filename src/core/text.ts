const ANSI_REGEX =
  /\u001b(?:\[(?:[0-?]*[ -/]*[@-~])|\].*?(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/**
 * Removes ANSI color and terminal escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  return text.replace(ANSI_REGEX, "");
}
