import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/middleware";
import { EMAIL_ICONS, ICON_CHIP_SIZE, LOCKUP_SIZE, MARK_SIZE, assetFile, type IconName } from "@/emails/icons";

const root = path.resolve(import.meta.dirname, "../../..");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number; colourType: number } {
  const buf = readFileSync(path.join(root, "public/email", file));
  expect(buf.subarray(0, 8).toString("hex"), `${file} is not a PNG`).toBe("89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] };
}

describe("public/email images", () => {
  const entries: Array<[string, (scale: 1 | 2) => string, number, number]> = [
    ...(["light", "dark"] as const).flatMap((theme): Array<[string, (scale: 1 | 2) => string, number, number]> => [
      [`mark-${theme}`, (s) => assetFile.mark(theme, s), MARK_SIZE, MARK_SIZE],
      [`lockup-${theme}`, (s) => assetFile.lockup(theme, s), LOCKUP_SIZE.width, LOCKUP_SIZE.height],
    ]),
    ...(Object.keys(EMAIL_ICONS) as IconName[]).map((name): [string, (scale: 1 | 2) => string, number, number] => [`icon-${name}`, (s) => assetFile.icon(name, s), ICON_CHIP_SIZE, ICON_CHIP_SIZE]),
  ];

  it.each(entries)("%s exists at 1x and 2x with the size the templates declare and an alpha channel", (_name, file, width, height) => {
    for (const scale of [1, 2] as const) {
      expect(existsSync(path.join(root, "public/email", file(scale))), file(scale)).toBe(true);
      const size = pngSize(file(scale));
      expect(size.width).toBe(width * scale);
      expect(size.height).toBe(height * scale);
      expect(size.colourType, `${file(scale)} needs RGBA (colour type 6) for a transparent background`).toBe(6);
    }
  });
});

describe("serving the images without a login", () => {
  // Next compiles a matcher into a regular expression anchored on the whole path.
  const matches = (pathname: string) => new RegExp(`^${config.matcher[0]}$`).test(pathname);

  it("keeps the session middleware (and its redirect to /login) off every .png", () => {
    expect(matches("/email/mark-light@2x.png")).toBe(false);
    expect(matches("/email/icon-mail-check@2x.png")).toBe(false);
    expect(matches("/email/lockup-dark.png")).toBe(false);
  });

  it("still protects the app", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/tenders")).toBe(true);
    expect(matches("/email/anything.html")).toBe(true);
  });
});
