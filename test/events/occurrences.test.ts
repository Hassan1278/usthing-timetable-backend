import { expect, test } from "bun:test";
import {
  generateOccurrences,
  MAX_OCCURRENCES_PER_SERIES,
  type OccurrenceRange,
  type OccurrenceSource,
} from "../../src/events/occurrences.js";
import { EventValidationError } from "../../src/events/validation.js";

const day = 86_400_000;
const offset = 8 * 60 * 60 * 1000;
const weekly: OccurrenceSource = {
  schedule: {
    kind: "timed",
    startsAt: "2026-10-05T18:00:00+08:00",
    endsAt: "2026-10-05T19:00:00+08:00",
  },
  recurrence: { frequency: "weekly", endsOn: "2027-10-05" },
};
const week = { from: "2026-10-12", to: "2026-10-19" };

test("weekly expansion returns the second meeting even though its stored start is outside the range", () => {
  expect(generateOccurrences(weekly, week)).toEqual([
    {
      originalStart: "2026-10-12T10:00:00.000Z",
      schedule: {
        kind: "timed",
        startsAt: "2026-10-12T10:00:00.000Z",
        endsAt: "2026-10-12T11:00:00.000Z",
      },
    },
  ]);
});

test("daily expansion preserves time and duration across year boundaries", () => {
  const source: OccurrenceSource = {
    schedule: {
      kind: "timed",
      startsAt: "2026-12-30T23:30:00+08:00",
      endsAt: "2026-12-31T00:30:00+08:00",
    },
    recurrence: { frequency: "daily", endsOn: "2027-01-02" },
  };
  const results = generateOccurrences(source, {
    from: "2027-01-01",
    to: "2027-01-03",
  });
  expect(results.map((item) => item.originalStart)).toEqual([
    "2026-12-31T15:30:00.000Z",
    "2027-01-01T15:30:00.000Z",
    "2027-01-02T15:30:00.000Z",
  ]);
  for (const item of results) {
    if (item.schedule.kind === "timed")
      expect(
        Date.parse(item.schedule.endsAt) - Date.parse(item.schedule.startsAt),
      ).toBe(3600000);
  }
});

test("all-day occurrences preserve exclusive dates across leap day", () => {
  const source: OccurrenceSource = {
    schedule: { kind: "all-day", startsOn: "2028-02-28", endsOn: "2028-02-29" },
    recurrence: { frequency: "daily", endsOn: "2028-03-01" },
  };
  expect(
    generateOccurrences(source, { from: "2028-02-29", to: "2028-03-02" }),
  ).toEqual([
    {
      originalStart: "2028-02-29",
      schedule: {
        kind: "all-day",
        startsOn: "2028-02-29",
        endsOn: "2028-03-01",
      },
    },
    {
      originalStart: "2028-03-01",
      schedule: {
        kind: "all-day",
        startsOn: "2028-03-01",
        endsOn: "2028-03-02",
      },
    },
  ]);
});

test("weekly all-day events do not become daily or lose their duration", () => {
  const results = generateOccurrences(
    {
      schedule: {
        kind: "all-day",
        startsOn: "2026-10-05",
        endsOn: "2026-10-07",
      },
      recurrence: { frequency: "weekly", endsOn: "2026-10-20" },
    },
    { from: "2026-10-06", to: "2026-10-21" },
  );
  expect(results.map((item) => item.originalStart)).toEqual([
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
  ]);
});

test("inclusive recurrence end follows the HK start date, not the UTC date", () => {
  const source: OccurrenceSource = {
    schedule: {
      kind: "timed",
      startsAt: "2026-10-04T16:30:00Z",
      endsAt: "2026-10-04T17:30:00Z",
    },
    recurrence: { frequency: "daily", endsOn: "2026-10-06" },
  };
  expect(
    generateOccurrences(source, { from: "2026-10-05", to: "2026-10-08" }).map(
      (item) => item.originalStart,
    ),
  ).toEqual(["2026-10-04T16:30:00.000Z", "2026-10-05T16:30:00.000Z"]);
});

test("occurrences may finish after the recurrence end and overlap a later range", () => {
  expect(
    generateOccurrences(
      {
        schedule: {
          kind: "all-day",
          startsOn: "2026-10-05",
          endsOn: "2026-10-08",
        },
        recurrence: { frequency: "daily", endsOn: "2026-10-05" },
      },
      { from: "2026-10-07", to: "2026-10-08" },
    ),
  ).toHaveLength(1);
});

test.each([
  {
    kind: "timed",
    startsAt: "2026-10-04T23:00:00+08:00",
    endsAt: "2026-10-05T00:00:00+08:00",
  },
  {
    kind: "timed",
    startsAt: "2026-10-06T00:00:00+08:00",
    endsAt: "2026-10-06T01:00:00+08:00",
  },
  { kind: "all-day", startsOn: "2026-10-04", endsOn: "2026-10-05" },
  { kind: "all-day", startsOn: "2026-10-06", endsOn: "2026-10-07" },
] as const)("touching boundaries are excluded %#", (schedule) => {
  expect(
    generateOccurrences({ schedule }, { from: "2026-10-05", to: "2026-10-06" }),
  ).toEqual([]);
});

test("normal events expand to zero or one occurrence without inventing recurrence", () => {
  const source = { schedule: weekly.schedule };
  expect(generateOccurrences(source, week)).toEqual([]);
  expect(
    generateOccurrences(source, { from: "2026-10-05", to: "2026-10-06" }),
  ).toHaveLength(1);
});

test("far-future and pre-series ranges return no occurrences", () => {
  expect(
    generateOccurrences(weekly, { from: "9998-01-01", to: "9998-01-02" }),
  ).toEqual([]);
  expect(
    generateOccurrences(weekly, { from: "0001-01-01", to: "0001-01-02" }),
  ).toEqual([]);
});

test("series expansion is immutable and occurrence identities are stable across query windows", () => {
  const source = structuredClone(weekly);
  const before = structuredClone(source);
  const first = generateOccurrences(source, week);
  const broader = generateOccurrences(source, {
    from: "2026-10-05",
    to: "2026-10-20",
  });
  expect(broader[1]).toEqual(first[0]);
  if (first[0]!.schedule.kind === "timed") {
    first[0]!.schedule.startsAt = "changed";
  }
  expect(source).toEqual(before);
  expect(generateOccurrences(source, week)[0]).toEqual(broader[1]);
});

test.each([
  null,
  {},
  { from: "2026-10-05" },
  { from: "2026-02-30", to: "2026-03-01" },
  { from: "2026-10-05", to: "2026-10-05" },
  { from: "2026-10-06", to: "2026-10-05" },
  { from: "2026-01-01", to: "2027-01-01" },
  { from: "2026-10-05", to: "2026-10-06", limit: 999999 },
  { from: "2026-10-05", to: "2026-10-06", timeZone: "UTC" },
])("rejects invalid or unbounded ranges at runtime %#", (range) => {
  expect(() => generateOccurrences(weekly, range as OccurrenceRange)).toThrow(
    EventValidationError,
  );
});

test.each([
  null,
  {},
  { ...weekly, ownerId: "forged" },
  { ...weekly, exceptions: [] },
  { ...weekly, recurrence: { frequency: "daily" } },
  { ...weekly, recurrence: { frequency: "hourly", endsOn: "2027-10-05" } },
  {
    ...weekly,
    recurrence: { frequency: "daily", endsOn: "2027-10-05", interval: 0 },
  },
  { ...weekly, recurrence: { frequency: "daily", endsOn: "2026-10-04" } },
  { ...weekly, recurrence: { frequency: "daily", endsOn: "9999-01-01" } },
  { ...weekly, recurrence: { frequency: "daily", endsOn: "2027-02-29" } },
  { ...weekly, schedule: { kind: "timed", startsAt: "bad", endsAt: "bad" } },
  {
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-05" },
  },
  {
    schedule: {
      kind: "timed",
      startsAt: "2026-10-05T02:00:00Z",
      endsAt: "2026-10-05T01:00:00Z",
    },
  },
])(
  "rejects unsafe sources even when the requested window is outside the series %#",
  (source) => {
    expect(() =>
      generateOccurrences(source as OccurrenceSource, {
        from: "2030-01-01",
        to: "2030-01-02",
      }),
    ).toThrow(EventValidationError);
  },
);

test("93-day range is allowed; 94 days is rejected", () => {
  expect(() =>
    generateOccurrences(weekly, { from: "2026-01-01", to: "2026-04-04" }),
  ).not.toThrow();
  expect(() =>
    generateOccurrences(weekly, { from: "2026-01-01", to: "2026-04-05" }),
  ).toThrow(EventValidationError);
});

test("long overlapping events remain bounded at 367 occurrences, without truncation", () => {
  const result = generateOccurrences(
    {
      schedule: {
        kind: "all-day",
        startsOn: "2028-01-01",
        endsOn: "2030-01-01",
      },
      recurrence: { frequency: "daily", endsOn: "2029-01-01" },
    },
    { from: "2029-01-01", to: "2029-01-02" },
  );
  expect(result).toHaveLength(MAX_OCCURRENCES_PER_SERIES);
  expect(result[0]?.originalStart).toBe("2028-01-01");
  expect(result.at(-1)?.originalStart).toBe("2029-01-01");
});

test("shifted schedule overflow fails instead of returning invalid calendar dates", () => {
  expect(() =>
    generateOccurrences(
      {
        schedule: {
          kind: "all-day",
          startsOn: "9998-12-31",
          endsOn: "9999-12-31",
        },
        recurrence: { frequency: "daily", endsOn: "9999-12-31" },
      },
      { from: "9999-01-01", to: "9999-01-02" },
    ),
  ).toThrow(EventValidationError);
});

test("fractional seconds preserve touching boundaries and short positive durations", () => {
  const result = generateOccurrences(
    {
      schedule: {
        kind: "timed",
        startsAt: "2026-10-04T15:59:59.999Z",
        endsAt: "2026-10-04T16:00:00.001Z",
      },
      recurrence: { frequency: "daily", endsOn: "2026-10-05" },
    },
    { from: "2026-10-05", to: "2026-10-06" },
  );
  expect(result).toHaveLength(2);
});

// Independent bounded oracle: enumerate first, then filter using interval overlap.
function naive(source: OccurrenceSource, range: OccurrenceRange): string[] {
  const { schedule, recurrence } = source;
  const start = Date.parse(
    schedule.kind === "timed"
      ? schedule.startsAt
      : `${schedule.startsOn}T00:00:00+08:00`,
  );
  const end = Date.parse(
    schedule.kind === "timed"
      ? schedule.endsAt
      : `${schedule.endsOn}T00:00:00+08:00`,
  );
  const from = Date.parse(`${range.from}T00:00:00+08:00`);
  const to = Date.parse(`${range.to}T00:00:00+08:00`);
  const result: string[] = [];
  for (let n = 0; n < 367; n++) {
    const shift = n * (recurrence?.frequency === "weekly" ? 7 : 1) * day;
    const date = new Date(start + shift + offset).toISOString().slice(0, 10);
    if (n > 0 && !recurrence) break;
    if (recurrence && date > recurrence.endsOn) break;
    if (start + shift < to && end + shift > from)
      result.push(
        schedule.kind === "timed"
          ? new Date(start + shift).toISOString()
          : date,
      );
  }
  return result;
}

test("arithmetic matches exhaustive expansion across 600 deterministic schedules and windows", () => {
  const anchor = Date.parse("2028-01-01T00:00:00+08:00");
  const date = (value: number) =>
    new Date(value + offset).toISOString().slice(0, 10);
  for (let i = 0; i < 600; i++) {
    const start =
      anchor + (i % 50) * day + (i % 2 ? (i % 24) * 3600000 + (i % 1000) : 0);
    const end =
      start + (i % 2 ? ((i % 240) + 1) * 3600000 : ((i % 20) + 1) * day);
    const source: OccurrenceSource = {
      schedule:
        i % 2
          ? {
              kind: "timed",
              startsAt: new Date(start).toISOString(),
              endsAt: new Date(end).toISOString(),
            }
          : { kind: "all-day", startsOn: date(start), endsOn: date(end) },
      ...(i % 5
        ? {
            recurrence: {
              frequency: i % 3 ? ("daily" as const) : ("weekly" as const),
              endsOn: date(start + (i % 365) * day),
            },
          }
        : {}),
    };
    const from = anchor + (((i * 17) % 480) - 40) * day;
    const range = { from: date(from), to: date(from + ((i % 93) + 1) * day) };
    expect(
      generateOccurrences(source, range).map((item) => item.originalStart),
    ).toEqual(naive(source, range));
  }
});
