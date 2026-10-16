import crypto from "node:crypto";

export const ocId = (prefix: string): string => {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
};

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

/**
 * Mint an id in the shape the OpenCode gateway validates.
 *
 * The first six bytes are read out of `timestamp * 0x1000 + counter`, most
 * significant byte first; `ses_` inverts that value while `msg_` leaves it
 * ascending. Fourteen random base62 characters follow. The gateway decodes the
 * timestamp prefix of a session id, so a digest-shaped or purely random one is
 * refused with FreeTierError even when every header is correct.
 */
export const mintZenId = (prefix: "ses" | "msg", descending = true): string => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  if (descending) value = ~value;
  let time = "";
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  let random = "";
  for (let index = 0; index < 14; index += 1) {
    random += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}_${time}${random}`;
};
