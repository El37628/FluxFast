/** Small, dependency-free checks for the common formats emitted by Pydantic. */

export const VALIDATION_FORMATS = [
  "date",
  "date-time",
  "email",
  "ipv4",
  "ipv6",
  "time",
  "uri",
  "uuid"
] as const;

export type ValidationFormat = (typeof VALIDATION_FORMATS)[number];

/** Maximum pattern source accepted by the native validator. */
export const VALIDATION_PATTERN_MAX_LENGTH = 8192;

/**
 * Return a diagnostic for a pattern that cannot be safely translated to the
 * native JavaScript runtime, or `undefined` when it is in the supported
 * subset. Patterns are authored by trusted developers but run against
 * hostile input, so the subset deliberately excludes constructs with
 * cross-engine semantics or common backtracking hazards.
 */
export function validationPatternError(pattern: string): string | undefined {
  if (pattern.length > VALIDATION_PATTERN_MAX_LENGTH) {
    return `pattern is too long (maximum ${VALIDATION_PATTERN_MAX_LENGTH} characters)`;
  }
  if (/\\(?:[0-9]|k<|[wWdDsSpPbBAZ])/.test(pattern)) {
    return "pattern uses a regex escape whose semantics are not portable to the native validator";
  }
  if (/\\p\{/.test(pattern)) {
    return "Unicode property escapes are not supported by the native validator";
  }
  if (/\(\?(?:[=!]|<[=!]|[a-zA-Z-]+(?:\)|:|=|!))/.test(pattern)) {
    return "lookaround or inline regex flags are not supported by the native validator";
  }
  if (/\(\?P<|\(\?<[^=!]/.test(pattern)) {
    return "named capture groups are not supported by the native validator";
  }
  if (/\)(?:[*+?]|\{\d+(?:,\d*)?\})(?:[?+])?/.test(pattern)) {
    return "quantified groups are rejected to keep validation traversal bounded";
  }
  let quantifiers = 0;
  let inCharacterClass = false;
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "*" || character === "+" || character === "?") {
      quantifiers += 1;
    }
  }
  if (quantifiers > 1) {
    return "patterns with multiple quantifiers are rejected to keep validation linear";
  }
  return undefined;
}

const SUPPORTED_FORMATS = new Set<string>(VALIDATION_FORMATS);

export function isSupportedValidationFormat(
  format: string
): format is ValidationFormat {
  return SUPPORTED_FORMATS.has(format);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDateParts(
  yearText: string,
  monthText: string,
  dayText: string
): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

function isValidTime(value: string, requireZone: boolean): boolean {
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, hours, minutes, seconds = "00", zone] = match;
  const validClock =
    Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59;
  if (!validClock) return false;
  if (requireZone && !zone) return false;
  if (!zone || zone.toUpperCase() === "Z") return true;
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(4, 6));
  return offsetHours <= 23 && offsetMinutes <= 59;
}

function isValidDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  return match ? isValidDateParts(match[1], match[2], match[3]) : false;
}

function isValidDateTime(value: string): boolean {
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  return (
    isValidDateParts(match[1], match[2], match[3]) &&
    isValidTime(
      `${match[4]}:${match[5]}${match[6] ? `:${match[6]}` : ""}${match[7] ?? ""}`,
      false
    )
  );
}

function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254 || /\s/.test(value)) {
    return false;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@") || at === value.length - 1) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".")) {
    return false;
  }
  if (local.includes("..") || domain.startsWith(".") || domain.endsWith(".")) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      label =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    )
  );
}

function isValidUri(value: string): boolean {
  if (value.length === 0 || /[\u0000-\u0020]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(part => {
      if (!/^\d{1,3}$/.test(part)) return false;
      if (part.length > 1 && part.startsWith("0")) return false;
      return Number(part) <= 255;
    })
  );
}

function isValidHextet(value: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(value);
}

function isValidIpv6(value: string): boolean {
  if (value.length === 0 || value.includes("%")) return false;
  let address = value;
  const hasIpv4Tail = address.includes(".");
  if (hasIpv4Tail) {
    const separator = address.lastIndexOf(":");
    if (separator < 0 || !isValidIpv4(address.slice(separator + 1))) {
      return false;
    }
    address = `${address.slice(0, separator + 1)}0:0`;
  }

  const compression = address.indexOf("::");
  if (compression !== -1 && compression !== address.lastIndexOf("::")) {
    return false;
  }

  if (compression === -1) {
    const segments = address.split(":");
    return segments.length === 8 && segments.every(isValidHextet);
  }

  const left = address.slice(0, compression).split(":").filter(Boolean);
  const right = address.slice(compression + 2).split(":").filter(Boolean);
  if (
    left.some(segment => !isValidHextet(segment)) ||
    right.some(segment => !isValidHextet(segment))
  ) {
    return false;
  }
  return left.length + right.length < 8;
}

/** Return whether a string satisfies one of the supported format checks. */
export function validateValidationFormat(
  value: string,
  format: ValidationFormat
): boolean {
  switch (format) {
    case "date":
      return isValidDate(value);
    case "date-time":
      return isValidDateTime(value);
    case "email":
      return isValidEmail(value);
    case "ipv4":
      return isValidIpv4(value);
    case "ipv6":
      return isValidIpv6(value);
    case "time":
      return isValidTime(value, false);
    case "uri":
      return isValidUri(value);
    case "uuid":
      return isValidUuid(value);
    default:
      return false;
  }
}
