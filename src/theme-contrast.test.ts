import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

const minimumNormalTextContrast = 4.5;

type Oklch = readonly [lightness: number, chroma: number, hue: number];
type LinearRgb = readonly [red: number, green: number, blue: number];
type Srgb = readonly [red: number, green: number, blue: number];

function readTheme(selector: ":root" | ".dark") {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("\n}", start);

  if (start === -1 || end === -1) {
    throw new Error(`Missing ${selector} theme block`);
  }

  return css.slice(start, end);
}

function readOklch(theme: string, token: string): Oklch {
  const value = theme.match(new RegExp(`--${token}: oklch\\(([^)]+)\\);`))?.[1];

  if (!value) {
    throw new Error(`Missing explicit --${token} OKLCH value`);
  }

  const channels = value.split(/\s+/).map(Number);
  if (channels.length !== 3 || channels.some(Number.isNaN)) {
    throw new Error(`Invalid --${token} OKLCH value: ${value}`);
  }

  return [channels[0], channels[1], channels[2]];
}

function toLinearRgb([lightness, chroma, hue]: Oklch): LinearRgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function clamp(channel: number) {
  return Math.min(1, Math.max(0, channel));
}

function linearToSrgb([red, green, blue]: LinearRgb): Srgb {
  return [red, green, blue].map((channel) =>
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055,
  ) as [number, number, number];
}

function srgbToLinear([red, green, blue]: Srgb): LinearRgb {
  return [red, green, blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
}

function luminance([red, green, blue]: LinearRgb) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: Oklch, background: Oklch) {
  return contrastFromLuminance(
    luminance(toLinearRgb(foreground)),
    luminance(toLinearRgb(background)),
  );
}

function contrastOnTint(
  foreground: Oklch,
  tint: Oklch,
  base: Oklch,
  tintOpacity: number,
) {
  const tintRgb = linearToSrgb(toLinearRgb(tint));
  const baseRgb = linearToSrgb(toLinearRgb(base));
  const blended: Srgb = [
    tintRgb[0] * tintOpacity + baseRgb[0] * (1 - tintOpacity),
    tintRgb[1] * tintOpacity + baseRgb[1] * (1 - tintOpacity),
    tintRgb[2] * tintOpacity + baseRgb[2] * (1 - tintOpacity),
  ];

  return contrastFromLuminance(
    luminance(toLinearRgb(foreground)),
    luminance(srgbToLinear(blended)),
  );
}

function contrastFromLuminance(first: number, second: number) {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("semantic theme contrast", () => {
  it.each([
    ["light", readTheme(":root")],
    ["dark", readTheme(".dark")],
  ])("keeps %s action and status text at WCAG AA contrast", (mode, theme) => {
    const card = readOklch(theme, "card");
    const destructive = readOklch(theme, "destructive");
    const success = readOklch(theme, "success");
    const warning = readOklch(theme, "warning");
    const info = readOklch(theme, "info");
    const ratios = {
      primary: contrast(
        readOklch(theme, "primary-foreground"),
        readOklch(theme, "primary"),
      ),
      create: contrast(
        readOklch(theme, "create-foreground"),
        readOklch(theme, "create"),
      ),
      success: contrastOnTint(success, success, card, 0.12),
      warning: contrastOnTint(
        readOklch(theme, "warning-text"),
        warning,
        card,
        0.18,
      ),
      destructive: contrastOnTint(
        destructive,
        destructive,
        card,
        mode === "dark" ? 0.2 : 0.1,
      ),
      info: contrastOnTint(info, info, card, 0.12),
    };
    const failures = Object.entries(ratios)
      .filter(([, ratio]) => ratio < minimumNormalTextContrast)
      .map(([token, ratio]) => `${token}: ${ratio.toFixed(2)}:1`);

    expect(failures).toEqual([]);
  });
});
