// Small helpers shared by the client modules.

/** Drops trailing copies of one character with a loop (a `/x+$/` regex is quadratic on crafted input). */
export function stripTrailing(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}
