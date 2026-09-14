import { cronJobs } from "convex/server";
import { api } from "./_generated/api.js";

const crons = cronJobs();

// Drain persisted onCompleted work every minute. Callbacks are deduped by
// (envelope, kind) and survive failures, so this interval is a floor on
// delivery latency, not a correctness dependency.
crons.interval("zsign completions", { seconds: 60 }, api.zsign.processCompletions);

export default crons;
