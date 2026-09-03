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
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

const DATE_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE_TIME_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidTime(value: string, requireZone: boolean): boolean {
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, hours, minutes, seconds, zone] = match;
  const validClock =
    Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 60;
  if (!validClock) return false;
  if (requireZone && !zone) return false;
  if (!zone || zone === "Z") return true;
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
      `${match[4]}:${match[5]}:${match[6]}${match[7]}`,
      true
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
      return isValidTime(value, true);
    case "uri":
      return isValidUri(value);
    case "uuid":
      return isValidUuid(value);
    default:
      return false;
  }
}
