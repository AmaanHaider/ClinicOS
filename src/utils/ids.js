/**
 * ID generator — prefixed nanoids (e.g. appt_, dr_, res_) for all collection _id fields.
 */
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 20);

export function makeId(prefix) {
  return `${prefix}_${nanoid()}`;
}

