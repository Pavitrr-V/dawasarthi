import { afterEach, describe, expect, it } from "vitest";
import {
  DOSE_ACTION_TOKEN_TTL_MS,
  createDoseActionToken,
  doseActionUrl,
  verifyDoseActionToken,
} from "@/lib/push-token";

const DOSE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const originalSecret = process.env.PUSH_ACTION_SECRET;
const originalVapid = process.env.VAPID_PRIVATE_KEY;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.PUSH_ACTION_SECRET;
  else process.env.PUSH_ACTION_SECRET = originalSecret;

  if (originalVapid === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = originalVapid;
});

describe("dose action tokens", () => {
  it("round-trips a freshly minted token", () => {
    process.env.PUSH_ACTION_SECRET = "test-secret";
    const token = createDoseActionToken({ doseId: DOSE_ID, userId: USER_ID });

    const payload = verifyDoseActionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.dose_id).toBe(DOSE_ID);
    expect(payload?.user_id).toBe(USER_ID);
  });

  it("rejects a tampered payload", () => {
    process.env.PUSH_ACTION_SECRET = "test-secret";
    const token = createDoseActionToken({ doseId: DOSE_ID, userId: USER_ID });

    const [encoded, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        dose_id: "33333333-3333-4333-8333-333333333333",
        user_id: USER_ID,
        exp: Math.floor(Date.now() / 1000) + 600,
      })
    ).toString("base64url");

    expect(verifyDoseActionToken(`${forgedPayload}.${signature}`)).toBeNull();
    expect(verifyDoseActionToken(`${encoded}.deadbeef`)).toBeNull();
    expect(verifyDoseActionToken("not-a-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    process.env.PUSH_ACTION_SECRET = "test-secret";
    const now = Date.now();
    const token = createDoseActionToken({ doseId: DOSE_ID, userId: USER_ID, now });

    expect(verifyDoseActionToken(token, now + DOSE_ACTION_TOKEN_TTL_MS - 1000)).not.toBeNull();
    expect(verifyDoseActionToken(token, now + DOSE_ACTION_TOKEN_TTL_MS + 1000)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    process.env.PUSH_ACTION_SECRET = "secret-one";
    const token = createDoseActionToken({ doseId: DOSE_ID, userId: USER_ID });

    process.env.PUSH_ACTION_SECRET = "secret-two";
    expect(verifyDoseActionToken(token)).toBeNull();
  });

  it("builds an encoded action URL for a dose", () => {
    process.env.PUSH_ACTION_SECRET = "test-secret";
    const url = doseActionUrl(DOSE_ID, USER_ID);

    expect(url.startsWith(`/api/dose/${DOSE_ID}/action?token=`)).toBe(true);

    const token = url.split("token=")[1];
    const payload = verifyDoseActionToken(decodeURIComponent(token));
    expect(payload?.dose_id).toBe(DOSE_ID);
  });

  it("returns null instead of throwing when no secret is configured", () => {
    delete process.env.PUSH_ACTION_SECRET;
    delete process.env.VAPID_PRIVATE_KEY;
    expect(verifyDoseActionToken("whatever.whatever")).toBeNull();
  });
});
