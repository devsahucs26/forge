import { describe, it, expect } from "vitest";
import { stripAnsi } from "../src/core/text.js";

describe("stripAnsi", () => {
  it("removes basic text colors (foreground and background)", () => {
    const input = "\u001b[31mRed\u001b[0m \u001b[32mGreen\u001b[0m \u001b[44mBlueBg\u001b[0m";
    expect(stripAnsi(input)).toBe("Red Green BlueBg");
  });

  it("removes text formatting (bold, italic, underline)", () => {
    const input = "\u001b[1mBold\u001b[22m \u001b[3mItalic\u001b[23m \u001b[4mUnderline\u001b[24m";
    expect(stripAnsi(input)).toBe("Bold Italic Underline");
  });

  it("returns unchanged text when no ANSI escape codes are present", () => {
    const input = "Plain text without any colors or escapes 12345.";
    expect(stripAnsi(input)).toBe(input);
  });

  it("handles empty strings", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("removes complex sequences including OpenCode status codes and resets", () => {
    const input = "\x1B[0m\r\n> build · auto\r\n\x1B[0m\r\n";
    expect(stripAnsi(input)).toBe("\r\n> build · auto\r\n\r\n");
  });

  it("removes OSC operating system command escapes", () => {
    const input = "\u001b]0;Window Title\u0007Hello World";
    expect(stripAnsi(input)).toBe("Hello World");
  });
});
