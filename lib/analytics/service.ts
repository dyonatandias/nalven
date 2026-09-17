import { controlDb } from "@/db/control";
import { Prisma } from "@/generated/control/client";
import { ANALYTICS_TIMEZONE, FUNNEL_STEPS, addDays, eachDate, localDate, normalizePeriod, periodRange, validTimezone } from "./core";

export type AnalyticsSettingsValue = {
  enabled: boolean;
  trackAdmins: boolean;
  rawRetentionDays: number;
  dailyRetentionDays: number;
  heartbeatIntervalSeconds: number;
  timezone: string;
};

const DEFAULT_SETTINGS: AnalyticsSettingsValue = {
  enabled: true,
  trackAdmins: false,
  rawRetentionDays: 7,
  dailyRetentionDays: 365,
  heartbeatIntervalSeconds: 30,
  timezone: ANALYTICS_TIMEZONE,
};

type CountRow = Record<string, bigint | number | string | Date | null>;
const numberValue = (value: unknown) => typeof value === "bigint" ? Number(value) : Number(value || 0);
const dateValue = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);

export async function analyticsSettings(): Promise<AnalyticsSettingsValue> {
  const row = await controlDb.analyticsSettings.findUnique({ where: { id: 1 } });
  return row ? { enabled: row.enabled, trackAdmins: row.trackAdmins, rawRetentionDays: row.rawRetentionDays, dailyRetentionDays: row.dailyRetentionDays, heartbeatIntervalSeconds: row.heartbeatIntervalSeconds, timezone: row.timezone } : DEFAULT_SETTINGS;
}

export async function saveAnalyticsSettings(value: Partial<AnalyticsSettingsValue>) {
  const current = await analyticsSettings();
  const next = { ...current, ...value };
  next.rawRetentionDays = Math.max(1, Math.min(30, Math.round(Number(next.rawRetentionDays))));
  next.dailyRetentionDays = Math.max(30, Math.min(3650, Math.round(Number(next.dailyRetentionDays))));
  next.heartbeatIntervalSeconds = Math.max(10, Math.min(120, Math.round(Number(next.heartbeatIntervalSeconds))));
  if (!validTimezone(next.timezone)) throw new Error("Fuso horário inválido.");
  const row = await controlDb.analyticsSettings.upsert({ where: { id: 1 }, update: next, create: { id: 1, ...next } });
  return { enabled: row.enabled, trackAdmins: row.trackAdmins, rawRetentionDays: row.rawRetentionDays, dailyRetentionDays: row.dailyRetentionDays, heartbeatIntervalSeconds: row.heartbeatIntervalSeconds, timezone: row.timezone };
}

export async function incrementFunnelStep(step: string, at = new Date(), tx: Prisma.TransactionClient | typeof controlDb = controlDb, configuredTimezone?: string) {
  if (!FUNNEL_STEPS.some((item) => item.key === step)) return;
  const settings = configuredTimezone ? null : await analyticsSettings();
  if (settings && !settings.enabled) return;
  const timezone = configuredTimezone || settings!.timezone;
  const statDate = new Date(`${localDate(at, timezone)}T00:00:00.000Z`);
  await tx.analyticsFunnelDaily.upsert({
    where: { statDate_step: { statDate, step } },
    update: { count: { increment: 1 } },
    create: { statDate, step, count: 1 },
  });
}

export async function loadAnalyticsDashboard(periodValue: string | null | undefined) {
  const settings = await analyticsSettings();
  const range = periodRange(periodValue, settings.timezone);
  const availableRows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT MIN(day) AS "availableFrom", MAX(day) AS "availableTo" FROM (
      SELECT stat_date AS day FROM analytics_daily WHERE page_type = 'all'
      UNION ALL
      SELECT DATE(created_at AT TIME ZONE ${settings.timezone}) AS day FROM analytics_events WHERE event_kind = 'page_view'
    ) available
  `);
  const availableFrom = availableRows[0]?.availableFrom ? dateValue(availableRows[0].availableFrom) : null;
  const availableTo = availableRows[0]?.availableTo ? dateValue(availableRows[0].availableTo) : null;
  const from = range.key === "all" ? availableFrom : range.requestedFrom;
  const hasIntersection = Boolean(from && availableFrom && availableTo && availableTo >= from && availableFrom <= range.requestedTo);
  const effectiveFrom = hasIntersection ? maxDate(from!, availableFrom!) : from;
  const effectiveTo = hasIntersection ? minDate(range.requestedTo, availableTo!) : range.requestedTo;
  const coverage = {
    key: range.key,
    requestedFrom: from,
    requestedTo: range.requestedTo,
    availableFrom,
    availableTo,
    from: hasIntersection ? effectiveFrom : null,
    to: hasIntersection ? effectiveTo : null,
    complete: Boolean(hasIntersection && (range.key === "all" || availableFrom! <= range.requestedFrom! && availableTo! >= range.requestedTo)),
  };
  const currentFrom = effectiveFrom || from || range.today;
  const current = await loadStats(currentFrom, range.requestedTo, settings.timezone);
  const previous = range.previousFrom && range.previousTo ? await loadStats(range.previousFrom, range.previousTo, settings.timezone) : null;
  const [realtime, trends, pages, referrers, funnel] = await Promise.all([
    loadAnalyticsRealtime(),
    loadTrends(currentFrom, range.requestedTo, settings.timezone, range.key === "today"),
    loadTopPages(currentFrom, range.requestedTo, settings.timezone),
    loadReferrers(currentFrom, range.requestedTo, settings.timezone),
    loadFunnel(currentFrom, range.requestedTo),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    period: normalizePeriod(periodValue),
    coverage,
    metrics: {
      views: metric(current.views, previous?.views),
      visitors: metric(current.visitors, previous?.visitors),
      sessions: metric(current.sessions, previous?.sessions),
      avgDurationSeconds: metric(current.avgDurationSeconds, previous?.avgDurationSeconds),
      devices: current.devices,
      uniquenessMode: current.aggregatedDays > 0 ? "daily_sum" : "exact",
    },
    realtime,
    trends,
    pages,
    referrers,
    funnel,
    settings,
  };
}

async function loadStats(from: string, to: string, timezone: string) {
  const rows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
    WITH aggregated AS (
      SELECT COALESCE(SUM(views), 0) AS views,
             COALESCE(SUM(unique_visitors), 0) AS visitors,
             COALESCE(SUM(sessions), 0) AS sessions,
             COALESCE(SUM(avg_duration_seconds * sessions), 0) AS duration_weight,
             COALESCE(SUM(desktop_views), 0) AS desktop,
             COALESCE(SUM(mobile_views), 0) AS mobile,
             COALESCE(SUM(tablet_views), 0) AS tablet,
             COUNT(*) AS aggregated_days
      FROM analytics_daily
      WHERE page_type = 'all' AND stat_date BETWEEN ${from}::date AND ${to}::date
    ), raw AS (
      SELECT COUNT(*) AS views,
             COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash)) AS visitors,
             COUNT(DISTINCT session_hash) AS sessions,
             COUNT(*) FILTER (WHERE device_type = 'desktop') AS desktop,
             COUNT(*) FILTER (WHERE device_type = 'mobile') AS mobile,
             COUNT(*) FILTER (WHERE device_type = 'tablet') AS tablet
      FROM analytics_events e
      WHERE e.event_kind = 'page_view'
        AND DATE(e.created_at AT TIME ZONE ${timezone}) BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${timezone}) AND d.page_type = 'all')
    ), raw_duration AS (
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (last_seen_at - session_started_at))) FILTER (
        WHERE EXTRACT(EPOCH FROM (last_seen_at - session_started_at)) BETWEEN 3 AND 1800
      ), 0) AS average
      FROM analytics_sessions s
      WHERE DATE(s.session_started_at AT TIME ZONE ${timezone}) BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(s.session_started_at AT TIME ZONE ${timezone}) AND d.page_type = 'all')
    )
    SELECT aggregated.views + raw.views AS views,
           aggregated.visitors + raw.visitors AS visitors,
           aggregated.sessions + raw.sessions AS sessions,
           CASE WHEN aggregated.sessions + raw.sessions = 0 THEN 0 ELSE
             ROUND((aggregated.duration_weight + raw_duration.average * raw.sessions) / (aggregated.sessions + raw.sessions)) END AS avg_duration,
           aggregated.desktop + raw.desktop AS desktop,
           aggregated.mobile + raw.mobile AS mobile,
           aggregated.tablet + raw.tablet AS tablet,
           aggregated.aggregated_days AS aggregated_days
    FROM aggregated, raw, raw_duration
  `);
  const row = rows[0] || {};
  return {
    views: numberValue(row.views), visitors: numberValue(row.visitors), sessions: numberValue(row.sessions),
    avgDurationSeconds: numberValue(row.avg_duration), aggregatedDays: numberValue(row.aggregated_days),
    devices: { desktop: numberValue(row.desktop), mobile: numberValue(row.mobile), tablet: numberValue(row.tablet) },
  };
}

export async function loadAnalyticsRealtime() {
  const cutoff = new Date(Date.now() - 10 * 60_000);
  const rows = await controlDb.analyticsSession.findMany({ where: { lastSeenAt: { gte: cutoff } }, select: { visitorHash: true, sessionHash: true, pageType: true, pagePath: true } });
  const visitors = new Set(rows.map((row) => row.visitorHash || row.sessionHash));
  const pages = Object.entries(Object.groupBy(rows, (row) => row.pageType)).map(([pageType, values]) => ({ pageType, sessions: new Set((values || []).map((row) => row.sessionHash)).size })).sort((a, b) => b.sessions - a.sessions);
  return { visitors: visitors.size, sessions: rows.length, pages };
}

async function loadTrends(from: string, to: string, timezone: string, hourly: boolean) {
  if (hourly) {
    const rows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE ${timezone})::int AS hour,
             COUNT(*) AS views,
             COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash)) AS visitors
      FROM analytics_events
      WHERE event_kind = 'page_view' AND DATE(created_at AT TIME ZONE ${timezone}) = ${to}::date
      GROUP BY hour ORDER BY hour
    `);
    const byHour = new Map(rows.map((row) => [numberValue(row.hour), row]));
    return Array.from({ length: 24 }, (_, hour) => ({ key: `${to}T${String(hour).padStart(2, "0")}:00:00`, label: `${String(hour).padStart(2, "0")}h`, views: numberValue(byHour.get(hour)?.views), visitors: numberValue(byHour.get(hour)?.visitors) }));
  }
  const rows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
    WITH combined AS (
      SELECT stat_date AS day, views, unique_visitors AS visitors FROM analytics_daily
      WHERE page_type = 'all' AND stat_date BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT DATE(e.created_at AT TIME ZONE ${timezone}) AS day, COUNT(*)::int AS views,
             COUNT(DISTINCT COALESCE(NULLIF(e.visitor_hash, ''), e.session_hash))::int AS visitors
      FROM analytics_events e
      WHERE e.event_kind = 'page_view' AND DATE(e.created_at AT TIME ZONE ${timezone}) BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${timezone}) AND d.page_type = 'all')
      GROUP BY day
    ) SELECT day, SUM(views) AS views, SUM(visitors) AS visitors FROM combined GROUP BY day ORDER BY day
  `);
  const byDay = new Map(rows.map((row) => [dateValue(row.day), row]));
  return eachDate(from, to).map((day) => ({ key: day, label: day.slice(5).split("-").reverse().join("/"), views: numberValue(byDay.get(day)?.views), visitors: numberValue(byDay.get(day)?.visitors) }));
}

async function loadTopPages(from: string, to: string, timezone: string) {
  const rows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
    WITH combined AS (
      SELECT page_path, page_type, views, unique_visitors AS visitors FROM analytics_pages_daily
      WHERE stat_date BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT e.page_path, e.page_type, COUNT(*)::int AS views,
             COUNT(DISTINCT COALESCE(NULLIF(e.visitor_hash, ''), e.session_hash))::int AS visitors
      FROM analytics_events e
      WHERE e.event_kind = 'page_view' AND DATE(e.created_at AT TIME ZONE ${timezone}) BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${timezone}) AND d.page_type = 'all')
      GROUP BY e.page_path, e.page_type
    ) SELECT page_path, page_type, SUM(views) AS views, SUM(visitors) AS visitors
      FROM combined GROUP BY page_path, page_type ORDER BY views DESC, page_path ASC LIMIT 12
  `);
  return rows.map((row) => ({ path: String(row.page_path), pageType: String(row.page_type), views: numberValue(row.views), visitors: numberValue(row.visitors) }));
}

async function loadReferrers(from: string, to: string, timezone: string) {
  const rows = await controlDb.$queryRaw<CountRow[]>(Prisma.sql`
    WITH combined AS (
      SELECT source, views, unique_visitors AS visitors FROM analytics_referrers_daily
      WHERE stat_date BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT e.referrer_source AS source, COUNT(*)::int AS views,
             COUNT(DISTINCT COALESCE(NULLIF(e.visitor_hash, ''), e.session_hash))::int AS visitors
      FROM analytics_events e
      WHERE e.event_kind = 'page_view' AND DATE(e.created_at AT TIME ZONE ${timezone}) BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${timezone}) AND d.page_type = 'all')
      GROUP BY e.referrer_source
    ) SELECT source, SUM(views) AS views, SUM(visitors) AS visitors
      FROM combined GROUP BY source ORDER BY views DESC, source ASC LIMIT 10
  `);
  return rows.map((row) => ({ source: String(row.source), views: numberValue(row.views), visitors: numberValue(row.visitors) }));
}

async function loadFunnel(from: string, to: string) {
  const rows = await controlDb.analyticsFunnelDaily.groupBy({ by: ["step"], where: { statDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } }, _sum: { count: true } });
  const counts = new Map(rows.map((row) => [row.step, row._sum.count || 0]));
  return FUNNEL_STEPS.map((step, index) => { const count = counts.get(step.key) || 0; const next = FUNNEL_STEPS[index + 1]; const nextCount = next ? counts.get(next.key) || 0 : null; return { ...step, count, rateToNext: nextCount === null || count === 0 ? null : Math.round(nextCount / count * 1000) / 10 }; });
}

export async function aggregateAnalytics() {
  const settings = await analyticsSettings();
  const today = localDate(new Date(), settings.timezone);
  const yesterday = addDays(today, -1);
  const dates = await controlDb.$queryRaw<Array<{ day: Date }>>(Prisma.sql`
    SELECT DISTINCT DATE(e.created_at AT TIME ZONE ${settings.timezone}) AS day
    FROM analytics_events e
    WHERE DATE(e.created_at AT TIME ZONE ${settings.timezone}) < ${today}::date
      AND (DATE(e.created_at AT TIME ZONE ${settings.timezone}) = ${yesterday}::date
        OR NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${settings.timezone}) AND d.page_type = 'all'))
    ORDER BY day
  `);
  for (const row of dates) await aggregateDay(dateValue(row.day), settings.timezone);
  const rawCutoff = addDays(today, -settings.rawRetentionDays);
  const dailyCutoff = addDays(today, -settings.dailyRetentionDays);
  const [purgedEvents, purgedSessions] = await controlDb.$transaction(async (tx) => {
    const events = await tx.$executeRaw(Prisma.sql`
      DELETE FROM analytics_events e WHERE DATE(e.created_at AT TIME ZONE ${settings.timezone}) < ${rawCutoff}::date
      AND EXISTS (SELECT 1 FROM analytics_daily d WHERE d.stat_date = DATE(e.created_at AT TIME ZONE ${settings.timezone}) AND d.page_type = 'all')
    `);
    const sessions = await tx.analyticsSession.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
    await tx.analyticsPageDaily.deleteMany({ where: { statDate: { lt: new Date(`${dailyCutoff}T00:00:00.000Z`) } } });
    await tx.analyticsReferrerDaily.deleteMany({ where: { statDate: { lt: new Date(`${dailyCutoff}T00:00:00.000Z`) } } });
    await tx.analyticsDaily.deleteMany({ where: { statDate: { lt: new Date(`${dailyCutoff}T00:00:00.000Z`) } } });
    await tx.analyticsFunnelDaily.deleteMany({ where: { statDate: { lt: new Date(`${dailyCutoff}T00:00:00.000Z`) } } });
    return [events, sessions.count];
  });
  return { aggregatedDays: dates.length, purgedEvents, purgedSessions };
}

async function aggregateDay(day: string, timezone: string) {
  await controlDb.$transaction(async (tx) => {
    await tx.analyticsPageDaily.deleteMany({ where: { statDate: new Date(`${day}T00:00:00.000Z`) } });
    await tx.analyticsReferrerDaily.deleteMany({ where: { statDate: new Date(`${day}T00:00:00.000Z`) } });
    await tx.analyticsDaily.deleteMany({ where: { statDate: new Date(`${day}T00:00:00.000Z`) } });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO analytics_daily (stat_date, page_type, views, unique_visitors, sessions, desktop_views, mobile_views, tablet_views, avg_duration_seconds)
      SELECT ${day}::date, page_type, COUNT(*)::int,
        COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash))::int,
        COUNT(DISTINCT session_hash)::int,
        COUNT(*) FILTER (WHERE device_type = 'desktop')::int,
        COUNT(*) FILTER (WHERE device_type = 'mobile')::int,
        COUNT(*) FILTER (WHERE device_type = 'tablet')::int, 0
      FROM analytics_events WHERE event_kind = 'page_view' AND DATE(created_at AT TIME ZONE ${timezone}) = ${day}::date
      GROUP BY page_type
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO analytics_daily (stat_date, page_type, views, unique_visitors, sessions, desktop_views, mobile_views, tablet_views, avg_duration_seconds)
      SELECT ${day}::date, 'all', COUNT(*)::int,
        COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash))::int,
        COUNT(DISTINCT session_hash)::int,
        COUNT(*) FILTER (WHERE device_type = 'desktop')::int,
        COUNT(*) FILTER (WHERE device_type = 'mobile')::int,
        COUNT(*) FILTER (WHERE device_type = 'tablet')::int,
        COALESCE((SELECT ROUND(AVG(EXTRACT(EPOCH FROM (last_seen_at - session_started_at))))::int FROM analytics_sessions
          WHERE DATE(session_started_at AT TIME ZONE ${timezone}) = ${day}::date
            AND EXTRACT(EPOCH FROM (last_seen_at - session_started_at)) BETWEEN 3 AND 1800), 0)
      FROM analytics_events WHERE event_kind = 'page_view' AND DATE(created_at AT TIME ZONE ${timezone}) = ${day}::date
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO analytics_pages_daily (stat_date, page_hash, page_path, page_type, views, unique_visitors)
      SELECT ${day}::date, encode(digest(page_path, 'sha256'), 'hex'), page_path, page_type, COUNT(*)::int,
        COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash))::int
      FROM analytics_events WHERE event_kind = 'page_view' AND DATE(created_at AT TIME ZONE ${timezone}) = ${day}::date
      GROUP BY page_path, page_type
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO analytics_referrers_daily (stat_date, source_hash, source, views, unique_visitors)
      SELECT ${day}::date, encode(digest(referrer_source, 'sha256'), 'hex'), referrer_source, COUNT(*)::int,
        COUNT(DISTINCT COALESCE(NULLIF(visitor_hash, ''), session_hash))::int
      FROM analytics_events WHERE event_kind = 'page_view' AND DATE(created_at AT TIME ZONE ${timezone}) = ${day}::date
      GROUP BY referrer_source
    `);
  });
}

function metric(value: number, previous?: number) {
  return { value, previous: previous ?? null, change: previous ? Math.round((value - previous) / previous * 1000) / 10 : null };
}
function maxDate(a: string, b: string) { return a > b ? a : b; }
function minDate(a: string, b: string) { return a < b ? a : b; }
