import { describe, expect, it } from "vitest";
import {
  INVITE_ALPHABET,
  INVITE_LENGTH,
  INVITE_TTL_HOURS,
  generateInviteCode,
  inviteHoursLeft,
  isInviteExpired,
  isValidInviteCode,
  maskPhone,
  normalizeCaregiverPhone,
  normalizeInviteCode,
  firstName,
  joinPath,
  joinUrl,
  safeNextPath,
} from "@/lib/caregiver";

describe("generateInviteCode", () => {
  it("returns codes only drawn from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_LENGTH);
      for (const ch of code) expect(INVITE_ALPHABET).toContain(ch);
      expect(isValidInviteCode(code)).toBe(true);
    }
  });

  it("never emits ambiguous characters I, O, 0 or 1", () => {
    const joined = Array.from({ length: 100 }, () => generateInviteCode()).join("");
    for (const banned of ["I", "O", "0", "1"]) {
      expect(joined).not.toContain(banned);
    }
  });

  it("produces varied codes", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe("normalizeInviteCode / isValidInviteCode", () => {
  it("uppercases and strips separators", () => {
    expect(normalizeInviteCode(" abcd-2345 ")).toBe("ABCD2345");
  });

  it("drops characters outside the alphabet", () => {
    expect(normalizeInviteCode("A0O1I2")).toBe("A2");
  });

  it("rejects codes of the wrong length or alphabet", () => {
    expect(isValidInviteCode("ABC")).toBe(false);
    expect(isValidInviteCode("ABCD23456")).toBe(false);
    expect(isValidInviteCode("ABCD234O")).toBe(false);
    expect(isValidInviteCode("ABCD2345")).toBe(true);
  });
});

describe("isInviteExpired / inviteHoursLeft", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("is fresh right after creation", () => {
    expect(isInviteExpired("2026-01-01T11:00:00.000Z", now)).toBe(false);
    expect(inviteHoursLeft("2026-01-01T11:00:00.000Z", now)).toBe(INVITE_TTL_HOURS - 1);
  });

  it("expires after the TTL", () => {
    const old = new Date(now - (INVITE_TTL_HOURS + 1) * 60 * 60 * 1000).toISOString();
    expect(isInviteExpired(old, now)).toBe(true);
    expect(inviteHoursLeft(old, now)).toBe(0);
  });

  it("treats an unparseable date as expired", () => {
    expect(isInviteExpired("not-a-date", now)).toBe(true);
  });
});

describe("normalizeCaregiverPhone", () => {
  it("assumes +91 for a bare 10-digit mobile", () => {
    expect(normalizeCaregiverPhone("9876543210")).toBe("+919876543210");
    expect(normalizeCaregiverPhone("98 765 43210")).toBe("+919876543210");
  });

  it("accepts a 12-digit 91-prefixed number", () => {
    expect(normalizeCaregiverPhone("919876543210")).toBe("+919876543210");
  });

  it("keeps an international +number", () => {
    expect(normalizeCaregiverPhone("+14155550123")).toBe("+14155550123");
  });

  it("rejects invalid numbers", () => {
    expect(normalizeCaregiverPhone("12345")).toBeNull();
    expect(normalizeCaregiverPhone("1234567890")).toBeNull();
  });

  it("returns null for blank input", () => {
    expect(normalizeCaregiverPhone("")).toBeNull();
    expect(normalizeCaregiverPhone(null)).toBeNull();
  });
});

describe("maskPhone", () => {
  it("keeps only the last two digits", () => {
    expect(maskPhone("+919876543210")).toBe("+••••10");
  });

  it("passes through null", () => {
    expect(maskPhone(null)).toBeNull();
  });
});

describe("firstName", () => {
  it("returns the first token", () => {
    expect(firstName("Anjali Sharma")).toBe("Anjali");
    expect(firstName("Madonna")).toBe("Madonna");
    expect(firstName("")).toBe("the patient");
    expect(firstName(null)).toBe("the patient");
  });
});

describe("joinUrl / joinPath", () => {
  it("builds an absolute app URL", () => {
    expect(joinUrl("ABCD2345", "https://app.example.com")).toBe(
      "https://app.example.com/join?code=ABCD2345"
    );
  });

  it("trims a trailing slash", () => {
    expect(joinUrl("ABCD2345", "https://app.example.com/")).toBe(
      "https://app.example.com/join?code=ABCD2345"
    );
  });

  it("builds a relative path", () => {
    expect(joinPath("ABCD2345")).toBe("/join?code=ABCD2345");
  });
});

describe("safeNextPath", () => {
  it("allows same-origin relative paths", () => {
    expect(safeNextPath("/join?code=ABCD2345")).toBe("/join?code=ABCD2345");
    expect(safeNextPath("/home")).toBe("/home");
  });

  it("blocks open redirects", () => {
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });
});
