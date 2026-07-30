type LogContext = Record<string, unknown>;

function write(
  level: "warn" | "error" | "info",
  context: LogContext,
  message: string,
): void {
  const event = {
    level,
    service: "immune-standalone",
    message,
    ...context,
    at: new Date().toISOString(),
  };
  const serialized = JSON.stringify(event);
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}

export const logger = {
  warn(context: LogContext, message: string): void {
    write("warn", context, message);
  },
  error(context: LogContext, message: string): void {
    write("error", context, message);
  },
  info(context: LogContext, message: string): void {
    write("info", context, message);
  },
};
