/**
 * Icons used in the eyebrow chip of every email. Email clients cannot render
 * SVG, so scripts/build-email-assets.ts renders each one from lucide-react
 * (already a dependency) into public/email/icon-<name>.png and @2x.png.
 * The value is the lucide-react export name.
 */
export const EMAIL_ICONS = {
  "mail-check": "MailCheck",
  "user-plus": "UserPlus",
  "log-in": "LogIn",
  "key-round": "KeyRound",
  "at-sign": "AtSign",
  "shield-check": "ShieldCheck",
  "shield-off": "ShieldOff",
  "lock-keyhole": "LockKeyhole",
  smartphone: "Smartphone",
  link: "Link",
  unlink: "Unlink",
  "layout-dashboard": "LayoutDashboard",
  "clipboard-check": "ClipboardCheck",
  send: "Send",
  "alarm-clock": "AlarmClock",
} as const;

export type IconName = keyof typeof EMAIL_ICONS;

/** Logical (1x) sizes in CSS pixels. The PNGs are rendered at 1x and 2x. */
export const ICON_CHIP_SIZE = 44;
export const MARK_SIZE = 32;
export const LOCKUP_SIZE = { width: 164, height: 36 } as const;

/** File names under public/email, served at <site>/email/<file>. */
export const assetFile = {
  icon: (name: IconName, scale: 1 | 2 = 2) => `icon-${name}${scale === 2 ? "@2x" : ""}.png`,
  mark: (theme: "light" | "dark", scale: 1 | 2 = 2) => `mark-${theme}${scale === 2 ? "@2x" : ""}.png`,
  lockup: (theme: "light" | "dark", scale: 1 | 2 = 2) => `lockup-${theme}${scale === 2 ? "@2x" : ""}.png`,
};
