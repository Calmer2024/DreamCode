import { cleanName } from "./legacy-util.ts";

export function keyForUser(user) {
  return cleanName(user.displayName);
}
