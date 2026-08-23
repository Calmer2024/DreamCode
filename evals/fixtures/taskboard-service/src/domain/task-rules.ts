export function isKnownStatus(status) {
  return ["open", "done", "blocked"].includes(status);
}
