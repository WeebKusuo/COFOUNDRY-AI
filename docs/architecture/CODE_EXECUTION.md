# Code execution (coding round)

Candidate code is **never** executed in the Express process or on the API host. The only real
executor is a self-hosted **Judge0 CE** instance (GPL-3.0, used as a separate network service).
When none is configured (the default), execution is disabled: the candidate is told, runs return
503, hidden tests are reported as "unavailable" and the report produces no coding score.

**Blocker in this delivery:** a secure sandbox could not be demonstrated in the build
environment (starting containers/namespaces was refused, and Judge0 hosts are unreachable). The
Judge0 adapter is tested against a local HTTP stub only; execution stays disabled until a team
member deploys Judge0 as below and verifies it.

## Deploying Judge0 CE

1. Use a dedicated VM (not the API host), Judge0 CE **≥ 1.13.1** (fixes CVE-2024-28185 and
   CVE-2024-28189 sandbox escapes), Docker configured as Judge0's deployment guide requires (some releases need cgroup v1 on the host)
   (Judge0's isolate sandbox needs privileged workers).
2. In `judge0.conf`: `AUTHN_TOKEN=<long random>`, `ALLOW_ENABLE_NETWORK=false`,
   `ENABLE_NETWORK=false`, `ENABLE_WAIT_RESULT=true`, `MAX_CPU_TIME_LIMIT=5`,
   `MAX_WALL_TIME_LIMIT=12`, `MAX_MEMORY_LIMIT=262144`, `MAX_MAX_FILE_SIZE=1024`,
   `MAX_PROCESSES_AND_OR_THREADS=60`, `ENABLE_SUBMISSION_DELETE=true` (names as in the 1.13.x
   `judge0.conf`; check them against your release).
3. Firewall: no outbound internet from the workers; inbound only from the API host (TLS reverse
   proxy, or an SSH tunnel to `127.0.0.1`). No secrets or host files are mounted.
4. API: `CODE_EXECUTION_PROVIDER=judge0`, `JUDGE0_URL=https://…`, `JUDGE0_AUTH_TOKEN=…`, and the
   instance's language ids (`GET /languages`; CE defaults 63 Node.js, 71 Python 3).
5. Verify: run the coding round with a reference solution and a `while(true){}` loop (expect
   "Time limit exceeded"), an outbound `fetch` (expect failure), and a file read of `/etc/passwd`
   (expect the isolate sandbox's own filesystem).

## Limits applied per submission

`cpu_time_limit` 5 s (performance check 3 s), wall 10 s, memory 256 MB, stack 64 MB, 60
processes/threads, 1 MB files, `enable_network: false`, one run. Output read is capped at 256 KB
and stored diagnostics at 2,000 characters. Runs: 6 per minute per user, 30 per interview.

## Integrity of results

The harness (`apps/server/src/coding/grading.ts`) wraps the candidate function, runs each test's
arguments and prints JSON results after a random per-run marker. Expected values never enter
the sandbox; the server compares outputs, so printing fake results cannot pass a test without
computing correct values. Only the last marker counts. Hidden tests and reference solutions stay
on the server. Tasks are a fixed, versioned bank (`coding-tasks-v1`) chosen by the AI or by rule;
every expected value is verified against a reference implementation in tests.
