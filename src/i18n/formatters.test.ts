import { describe, expect, it } from "vitest";

import { formatDateTime } from "@/i18n/formatters";

describe("formatDateTime", () => {
  it("uses Intl to format the same instant for Chinese and English", () => {
    const instant = new Date("2026-07-28T08:30:00Z");
    const options = { timeZone: "UTC" };

    const chinese = formatDateTime(instant, "zh-CN", options);
    const english = formatDateTime(instant, "en", options);

    expect(chinese).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(instant),
    );
    expect(english).toBe(
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(instant),
    );
    expect(chinese).not.toBe(english);
  });

  it("accepts ISO timestamps from the Rust queue contract", () => {
    expect(
      formatDateTime("2026-07-28T08:30:00Z", "en", { timeZone: "UTC" }),
    ).toBe(
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-07-28T08:30:00Z")),
    );
  });
});
