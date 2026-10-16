import https from "node:https";

const ZEN_HOST = "opencode.ai";
// The free tier moved off `/zen/v1` on 2026-10-11; that path now answers every
// anonymous request with 403 FreeTierError.
const ZEN_PATH = "/inference/v1/chat/completions";
const OC_VERSION = "1.18.31";
const TIMEOUT_MS = 120000;

// Upstream model ids, not the client-facing names: this script talks to the
// upstream endpoint directly, and there the `-free` suffix is part of the id.
// The gateway strips it for clients (see src/models/naming.ts).
const MODELS = [
  "big-pickle",
  "space-bunny-free",
  "ll-alpha-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "mimo-v2.6-flash-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "longcat-2.5-preview-free",
  "beam-free",
  "jev-1.13-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
];

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

/** Mint an id in the shape the gateway validates: six timestamp bytes, then 14 base62. */
const ocId = (prefix, descending = true) => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  if (descending) value = ~value;
  let time = "";
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0");
  }
  let random = "";
  for (let index = 0; index < 14; index += 1) {
    random += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}_${time}${random}`;
};

const ZEN_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Requirement placeholder from OpenCode Zen: this gateway cannot execute it.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Requirement placeholder from OpenCode Zen: this gateway cannot execute it.",
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    },
  },
];

const testModel = (model) => {
  return new Promise((resolve) => {
    const started = Date.now();
    const session = ocId("ses");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      // The gate requires `stream: true` and a tool list carrying `bash`+`read`.
      stream: true,
      tools: ZEN_TOOLS,
    });
    const options = {
      hostname: ZEN_HOST,
      port: 443,
      path: ZEN_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": session,
        "x-opencode-session-id": session,
        "x-session-affinity": session,
        "x-session-id": session,
      },
      timeout: TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const durationMs = Date.now() - started;
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        if (res.statusCode === 200) {
          // The gate only serves SSE, so fold the deltas back into one message.
          let text = "";
          for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              text += chunk.choices?.[0]?.delta?.content ?? "";
            } catch {}
          }
          data = { choices: [{ message: { content: text } }] };
        } else {
          try { data = JSON.parse(raw); } catch {}
        }
        resolve({
          model,
          status: res.statusCode,
          durationMs,
          data,
          raw: raw.slice(0, 500),
        });
      });
    });

    req.on("error", (error) => {
      resolve({
        model,
        status: 0,
        durationMs: Date.now() - started,
        data: null,
        raw: `ERROR: ${error.message}`,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        model,
        status: 0,
        durationMs: Date.now() - started,
        data: null,
        raw: "TIMEOUT",
      });
    });

    req.write(body);
    req.end();
  });
};

const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const padRight = (str, len) => str.padEnd(len);
const padLeft = (str, len) => str.padStart(len);

const startTime = Date.now();

console.log("=".repeat(80));
console.log("OpenCode Zen Free Model Availability Test");
console.log(`Host: ${ZEN_HOST}${ZEN_PATH}`);
console.log(`Time: ${new Date().toISOString()}`);
console.log(`Models to test: ${MODELS.length}`);
console.log("=".repeat(80));
console.log("");

const results = [];
for (const model of MODELS) {
  const idx = MODELS.indexOf(model) + 1;
  process.stdout.write(`[${idx}/${MODELS.length}] Testing: ${model} ... `);
  const result = await testModel(model);
  results.push(result);

  if (result.status === 200 && result.data?.choices?.[0]?.message?.content) {
    const content = result.data.choices[0].message.content.slice(0, 50);
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | reply: "${content}"`);
  } else if (result.status === 200) {
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | (response received)`);
  } else {
    const errMsg = result.data?.error?.message || result.data?.type || result.raw?.slice(0, 150);
    console.log(`❌ ${result.status} | ${formatDuration(result.durationMs)} | ${errMsg}`);
  }
}

const totalDuration = Date.now() - startTime;

console.log("");
console.log("=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));
console.log("");

const available = results.filter(r => r.status === 200 && r.data?.choices?.length > 0);
const failed = results.filter(r => !(r.status === 200 && r.data?.choices?.length > 0));

console.log(`✅ Available: ${available.length}/${results.length}`);
console.log(`❌ Failed:     ${failed.length}/${results.length}`);
console.log(`⏱️  Total time: ${formatDuration(totalDuration)}`);
console.log("");

if (available.length > 0) {
  console.log("Available models:");
  for (const r of available) {
    console.log(`  ✓ ${padRight(r.model, 30)} ${padLeft(formatDuration(r.durationMs), 8)}`);
  }
  console.log("");
}

if (failed.length > 0) {
  console.log("Failed models:");
  for (const r of failed) {
    const detail = r.data?.error?.message || r.data?.type || `HTTP ${r.status}`;
    console.log(`  ✗ ${padRight(r.model, 30)} ${padLeft(formatDuration(r.durationMs), 8)}  ${detail.slice(0, 60)}`);
  }
  console.log("");
}

if (failed.length === 0) {
  console.log("🎉 All models are available!");
} else {
  console.log("⚠️  Some models are not available.");
  process.exitCode = 1;
}

