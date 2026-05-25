# HTTP Streaming — TradeStation API

> **Note:** Multiple concurrent streams can produce a large volume of data
> and may strain low-bandwidth connections.

## Overview

Some TradeStation API resources return HTTP streaming responses instead of
standard one-shot replies. Supported stream types include: accounts,
positions, barcharts, quote changes, option chains, and option spread quotes.

The stream keeps the HTTP connection open indefinitely. The server pushes data
as it becomes available without closing the connection, eliminating the
open/close latency of repeated polling.

**Lifecycle:**

1. Client opens the request and waits.
2. Server defers the response until an update is available, or a timeout/status occurs.
3. Server sends the update as part of the ongoing response.
4. Server returns to step 2 — the connection stays open.

Streaming resources are identified in the TradeStation API docs. All other
resources use the standard HTTP Request pattern.

---

## Response Headers

Most streams (`v2`):

```
Transfer-Encoding: chunked
Content-Type: application/vnd.tradestation.streams.v2+json
```

Orders and positions streams (`v3`):

```
Transfer-Encoding: chunked
Content-Type: application/vnd.tradestation.streams.v3+json
```

`Content-Length` is omitted — the body size is unknown at response start.

---

## Stream Termination and Status Messages

Unlike a canonical HTTP/1.1 stream, TradeStation streams **can** terminate.

### Error termination

When an error occurs, the server sends a JSON error object and the client
must close the connection:

```json
{"Symbol":"AAPL","Error":"DualLogon"}
```

After closing, the client may add a delay before reopening the stream.

### v3 stream status objects

`vnd.tradestation.streams.v3+json` streams include additional status messages:

| Message | Meaning |
|---|---|
| `{"StreamStatus":"EndSnapshot"}` | Initial snapshot is complete; live updates follow. |
| `{"StreamStatus":"GoAway"}` | Server is about to terminate the stream — client must restart it. |

---

## Chunked Encoding and JSON Parsing

### Healthy stream example (1 JSON object per chunk)

```
GET https://api.tradestation.com/v3/marketdata/stream/barcharts/MSFT?interval=1&unit=minute

HTTP/1.1 200 OK
Content-Type: application/vnd.tradestation.streams.v2+json
Transfer-Encoding: chunked

141
{"High":"233.87","Low":"233.75","Open":"233.87","Close":"233.75","TimeStamp":"2021-03-02T22:13:00Z","TotalVolume":"71551","DownTicks":1,"DownVolume":198,"OpenInterest":"0","IsRealtime":false,"IsEndOfHistory":false,"TotalTicks":2,"UnchangedTicks":0,"UnchangedVolume":0,"UpTicks":1,"UpVolume":71353,"Epoch":1614723180000}

13a
{"High":"233.88","Low":"233.88","Open":"233.88","Close":"233.88","TimeStamp":"2021-03-02T22:14:00Z","TotalVolume":"100","DownTicks":0,"DownVolume":0,"OpenInterest":"0","IsRealtime":false,"IsEndOfHistory":true,"TotalTicks":1,"UnchangedTicks":0,"UnchangedVolume":0,"UpTicks":1,"UpVolume":100,"Epoch":1614723240000}
```

### Variable chunking — you must handle all three cases

The chunk boundary and the JSON object boundary are **independent**. Proxies
are permitted (and in practice encouraged) by HTTP/1.1 to re-chunk streams.
Never parse by chunk boundary.

**Case 1 — 2 JSON objects in 1 chunk:**

```
27a
{"High":"233.65",...,"Epoch":1614722820000}
{"High":"233.98",...,"Epoch":1614723120000}
```

**Case 2 — 1 JSON object split across 2 chunks:**

```
6c
{"High":"231.49","Low":"231.37","Open":"231.4","Close":"231.46","TimeStamp":"2021-03-03T16:30:00Z","TotalVol
d8
ume":"24059","DownTicks":100,...,"Epoch":1614789000000}
```

A coffee-shop Wi-Fi proxy will almost certainly re-chunk compared to what
worked in development. Treat re-chunking as the default, not the exception.

### Recommended parsing strategy

1. Read raw bytes from the response buffer.
2. De-chunk the HTTP chunked encoding (strip hex-length lines and CRLF).
3. Append de-chunked text to an internal string buffer.
4. Split on `\n` (newline written after each JSON object) as a fast first
   pass — but use a proper streaming JSON parser or brace-depth counter as
   the robust fallback for the split-across-chunks case.

Do **not** attempt to parse along HTTP chunk boundaries.

---

## Connection Management

Streams run until a network interruption, a service disruption, a server
`GoAway`, or an error message. The client is responsible for:

- Detecting stream termination (EOF, socket error, or `GoAway` status).
- Implementing reconnect logic with a backoff delay.
- Not opening more concurrent streams than necessary — each consumes
  bandwidth and counts toward concurrent limits (see
  [`rate-limiting.md`](rate-limiting.md)).

---

## Related Documents

- [`rate-limiting.md`](rate-limiting.md) — Concurrent stream limits per
  resource category (e.g. 10 concurrent Option Quote Streams).
- [`rate-limiting-bars.md`](rate-limiting-bars.md) — Barchart stream credit
  costs and how streaming avoids repeated large history requests.
- [`endpoints.md`](endpoints.md) — Which endpoints are streaming vs.
  snapshot.
