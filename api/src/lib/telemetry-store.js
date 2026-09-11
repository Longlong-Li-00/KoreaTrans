import { TableClient } from "@azure/data-tables";

const DEFAULT_USAGE_TABLE = "KoreaTransUsage";
const DEFAULT_FEEDBACK_TABLE = "KoreaTransFeedback";

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function isConflict(error) {
  return error?.statusCode === 409 || error?.code === "EntityAlreadyExists";
}

export function createTelemetryStore(env) {
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) return null;

  const usageClient = TableClient.fromConnectionString(
    connectionString,
    env.AZURE_USAGE_TABLE_NAME || DEFAULT_USAGE_TABLE,
  );
  const feedbackClient = TableClient.fromConnectionString(
    connectionString,
    env.AZURE_FEEDBACK_TABLE_NAME || DEFAULT_FEEDBACK_TABLE,
  );
  let ready;

  async function ensureTables() {
    ready ??= Promise.all([
      usageClient.createTable().catch((error) => {
        if (!isConflict(error)) throw error;
      }),
      feedbackClient.createTable().catch((error) => {
        if (!isConflict(error)) throw error;
      }),
    ]);
    return ready;
  }

  return {
    async recordUsage({ userId, meetingId, eventId, seconds, recordedAt }) {
      await ensureTables();
      try {
        await usageClient.createEntity({
          partitionKey: monthKey(recordedAt),
          rowKey: eventId,
          userId,
          meetingId,
          seconds,
          recordedAt: recordedAt.toISOString(),
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    },

    async getMonthlyUsedSeconds(date) {
      await ensureTables();
      let total = 0;
      const filter = `PartitionKey eq '${monthKey(date)}'`;
      for await (const entity of usageClient.listEntities({ queryOptions: { filter } })) {
        const seconds = Number(entity.seconds);
        if (Number.isFinite(seconds) && seconds > 0) total += seconds;
      }
      return total;
    },

    async saveFeedback(entry) {
      await ensureTables();
      await feedbackClient.createEntity({
        partitionKey: monthKey(entry.createdAt),
        rowKey: entry.id,
        userId: entry.userId,
        displayName: entry.displayName,
        rating: entry.rating,
        category: entry.category,
        comment: entry.comment,
        status: entry.status,
        meetingDurationSeconds: entry.meetingDurationSeconds,
        finalCaptionCount: entry.finalCaptionCount,
        gapCount: entry.gapCount,
        appVersion: entry.appVersion,
        createdAt: entry.createdAt.toISOString(),
      });
    },

    async listFeedback(limit = 200) {
      await ensureTables();
      const entries = [];
      for await (const entity of feedbackClient.listEntities()) {
        entries.push({
          id: entity.rowKey,
          userId: entity.userId,
          displayName: entity.displayName,
          rating: Number(entity.rating),
          category: entity.category,
          comment: entity.comment,
          status: entity.status,
          meetingDurationSeconds: Number(entity.meetingDurationSeconds),
          finalCaptionCount: Number(entity.finalCaptionCount),
          gapCount: Number(entity.gapCount),
          appVersion: entity.appVersion,
          createdAt: entity.createdAt,
        });
      }
      return entries
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, limit);
    },
  };
}

export function utcMonthRange(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
