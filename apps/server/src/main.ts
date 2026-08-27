import { createServerRuntime } from "./createServerRuntime.ts";

const runtime = await createServerRuntime();
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref();
  try { await runtime.close(); process.exitCode = 0; }
  catch { process.exitCode = 1; }
  finally { clearTimeout(forced); }
  if (signal) process.kill(process.pid, signal === "SIGINT" ? "SIGINT" : "SIGTERM");
}
process.once("SIGTERM", () => void shutdown(""));
process.once("SIGINT", () => void shutdown(""));
await runtime.start();
