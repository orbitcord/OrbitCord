# Mass-delete diagnosis, 2026-10-16

The old implementation only discovered messages through Discord search. `run()` moved its maximum message ID backwards after every page and finished on an empty search page. A message missing from the index never entered the deletion queue, even if it appeared in normal channel history. The code retried HTTP 202 indexing responses, but a successful HTTP 200 with incomplete results bypassed that handling.

Reproduced in Chromium with the real injected extension and a REST fixture. Search omitted 60 newer own messages while history returned them among 120 newer messages. The old implementation left all 60 behind in DM, channel and server scopes. With every own message omitted from search, it returned `deleted: 0, failed: false` despite 62 deletable messages remaining.

The fix keeps search for historical discovery, records the newest indexed ID per channel, then paginates normal history backwards to that boundary. When a channel has no indexed own messages, it walks history to the end. Server scope also discovers guild channels and active threads so channels without search hits are checked. Only the current user's messages enter the deletion queue. IDs already attempted through search are not attempted twice. Both discovery paths use an upper snowflake bound captured at job start to exclude messages sent while the job runs.

History requests retry rate limits and transient failures. Unavailable histories produce an incomplete-check notice instead of an unqualified success. Stop is checked after each request and before deletion. Parallel work is awaited to completion even when one worker fails, so the status bar cannot disappear while another worker is still deleting.

API reference: [Discord message history](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx#get-channel-messages) supports `before` pagination and pages of up to 100 messages.

Verification: the four new discovery regression cases failed before the fix. All ten mass-delete cases then passed, covering indexed and unindexed messages, more than one history page, empty search, server channels and active threads without search hits, author/scope filtering, duplicate prevention, skipped system messages, rate limits, stopping, messages sent after job start, and HTTP 403/500 history failures. The complete extensions suite passed all 30 tests. JavaScript syntax and diff whitespace checks also passed. No live-account deletion was used for verification.

Risks: a server with long histories in channels without indexed own messages can require many history requests. Processing is bounded to four channels at a time and one page per channel. Archived threads absent from search and the active-thread listing remain undiscoverable through this fallback; archived threads present in search are still included. The fixtures reproduce incomplete search results; they do not establish the precise indexing state during the user's original incident.

## Scheduler speed, 2026-10-29

Two controlled Chromium regressions reproduced avoidable delays before the fix. When a delete in the first search page was held open, later pages' other channels could not delete anything. A rate-limit response requesting 120 ms still prevented retrying after 149 ms because `retryAfter()` imposed a one-second minimum. The delete lane also imposed an additional 250 ms minimum, and indexing imposed three seconds even when Discord supplied a shorter positive delay.

The search producer now feeds a bounded queue across pages. Each channel still has one sequential delete worker, and at most four channels work at once. There are at most 100 queued or active message records, plus the search page waiting to enter the queue. Workers share the existing channel quota state, so reading ahead does not permit concurrent deletes in the same channel. History discovery still runs after queued deletes settle and uses the original author, scope, deduplication and start-time bounds.

Retry delays accept fractional seconds from the response body or Retry-After header. Missing or invalid values retain a two-second fallback, and zero or very small delays have a 50 ms floor to avoid a retry loop. Case-insensitive header lookup handles both Headers instances and header objects. Global cooldowns now pause search requests as well as history and deletes, and overlapping pauses preserve the longer deadline. Indexing follows a supplied positive retry delay. Stop clears cooldown timers immediately while still awaiting requests already in flight.

Synthetic benchmark, `node scripts/bench-mass-delete.mjs [source snapshot]`:

| Scenario | Before | After |
| --- | ---: | ---: |
| 100 messages across two channels | 1,673 ms | 1,016 ms |
| First delete in the other channel | 918 ms | 262 ms |
| One retry requesting a 120 ms cooldown | 1,003 ms | 121 ms |

The mixed-channel fixture uses 25 newest messages in one channel with 35 ms delete latency, followed by 75 in another channel with 1 ms latency. Search returns pages of 25, with the production 250 ms search interval and available delete quotas. The retry fixture uses one message and a 1 ms search interval to isolate the cooldown. These are scheduler measurements, not live Discord throughput claims. Both implementations deleted the same number of messages.

Verification: both initial performance regressions failed against the old implementation. All 18 deletion checks pass after the change, including bounded lookahead, concurrency, stop during network waits and cooldowns, mixed-case quota headers, global Retry-After, indexing retries, missing retry data, unindexed history, scope/author filtering, new-message exclusion and incomplete-history notices. App build, JavaScript syntax and diff whitespace checks pass. No real messages were deleted for verification.

Reference: [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits) specifies fractional retry delays, response headers and global limits.

Risks: live performance depends on Discord's quotas and latency. Single-channel jobs still serialize deletes and cannot exceed their route limit. Reading ahead may reach the search endpoint's limit sooner; 429 retries and global pauses remain in effect. Existing history fallback costs and archived-thread discovery limits described above remain.

## Large-DM request latency, 2026-10-29

The cross-channel scheduler above does not remove single-channel network latency. A DM with 1,200 own messages and 100 ms per delete still took 120 seconds, even when the fixture reported ample quota. Every request waited for the previous response.

DM deletion now sends small rounds of up to three requests, bounded by the smallest remaining-quota count returned in the previous round. The first request is always sequential. Every response in a round must settle before the next round starts; taking the minimum quota across the round handles response reordering without treating stale, higher counts as new capacity. An exhausted quota waits for its reset and probes with one request. Missing quota headers or any request error disables overlap for the rest of that channel's job. Server channels retain their previous one-request-per-channel behavior. Stop awaits active requests and prevents another round from starting.

Repeatable simulated-time benchmark, `node scripts/bench-mass-delete.mjs [source snapshot]`, with 1,200 messages and 100 ms response latency:

| Fixture condition | Before DM pipeline | After | 429 responses |
| --- | ---: | ---: | ---: |
| 60 requests per second, latency is the bottleneck | 120.0 s | 43.2 s | 0 |
| 5 requests per second, quota is the bottleneck | 239.5 s | 239.3 s | 0 |
| Quota headers unavailable | 120.0 s | 120.0 s | 0 |

These quotas are test inputs, not hard-coded Discord limits. The benchmark uses production search pacing, quota resets and a bounded queue. The large-DM Chromium regression failed before the pipeline because the job was still unfinished at 45 seconds of simulated time; it now completes with exactly 1,200 unique deletes and a maximum of three active requests.

Verification adds cases for out-of-order quota responses, absent headers, cancellation during an active DM round, and returning to sequential deletion after a 429. Combined with the previous deletion checks, all 23 deletion regressions pass. The unrelated media-gallery assertion was updated to the UI wording from the earlier copy pass. Build, syntax and whitespace checks pass. No live-account deletion was used.

Risks: quota-bound DMs will see little improvement, and clients that do not expose quota headers remain sequential. Discord may change a quota or another action may consume it between responses; any resulting throttling immediately disables overlap and follows the supplied cooldown. The fixture speedup is not a promise that a real 1,200-message DM will finish in 43 seconds.
