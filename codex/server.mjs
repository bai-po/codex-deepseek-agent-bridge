#!/usr/bin/env node
import {legacyResultView,taskResultView} from './lib/read-policy.mjs';
/**
 * deepseek-bridge MCP server (Codex side of the local Agent Bridge)
 *
 * Zero-dependency Node ESM (>= 22). Transport: newline-delimited JSON-RPC 2.0 on
 * stdio (no LSP Content-Length framing). Every tool call is a pure HTTP request to
 * the loopback Agent Bridge service exposed by the DeepSeek Harness (DSH) plugin.
 *
 * Wire contract: agent-bridge/docs/protocol.md
 *   discovery  %USERPROFILE%\.dsh\agent-bridge\endpoint.json  (or DSH_AGENT_BRIDGE_HOME)
 *   auth       Authorization: Bearer <token from tokenPath>
 *   envelope   {"ok":true,"value":<T>} | {"ok":false,"error":{"code","message"}}
 *
 * This process must never crash because DSH is not running: every failure is
 * converted into a structured tool result. Only stdout carries protocol frames;
 * logs go to stderr (silent unless DSH_BRIDGE_DEBUG=1).
 */

import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SERVER_NAME = "deepseek-bridge";
const SERVER_VERSION = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8")).version;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const HTTP_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 4_000;
const WAIT_DEFAULT_MS = 0;
const WAIT_MAX_MS = 30_000;
const SUMMARY_LIMIT = 4_000;
const TASK_STATUSES = new Set(["DONE", "BLOCKED", "QUESTION", "INFO"]);
const TASK_MODES = new Set(["queue", "now"]);
const RESPONSE_BODY_LIMIT = 2 * 1024 * 1024;

const DEBUG = process.env.DSH_BRIDGE_DEBUG === "1";

function log(...args) {
  if (DEBUG) process.stderr.write(`[deepseek-bridge] ${args.join(" ")}\n`);
}

/* ------------------------------------------------------------------ errors */

class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details || {};
  }

  toPayload() {
    return { ok: false, code: this.code, message: this.message, ...this.details };
  }
}

function badRequest(message, details) {
  return new BridgeError("request/bad-request", message, details);
}

/* ---------------------------------------------------------------- discovery */

function dshBridgeHome() {
  if (process.env.DSH_AGENT_BRIDGE_HOME) return path.resolve(process.env.DSH_AGENT_BRIDGE_HOME);
  return path.join(os.homedir(), ".dsh", "agent-bridge");
}

function codexHome() {
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), ".codex");
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Load endpoint.json + token and return a normalized bridge handle.
 * Throws BridgeError("bridge/not-ready" | "bridge/endpoint-*" | "bridge/token-*").
 */
async function loadBridge() {
  const home = dshBridgeHome();
  const endpointPath = path.join(home, "endpoint.json");

  let raw;
  try {
    raw = await readFile(endpointPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new BridgeError(
        "bridge/not-ready",
        `Agent Bridge endpoint file not found: ${endpointPath}`,
        {
          endpointPath,
          hint:
            "Start the DeepSeek Harness desktop app (with the agent-bridge DSH plugin enabled). " +
            "The file appears once the bridge HTTP service is listening.",
        },
      );
    }
    throw new BridgeError("bridge/endpoint-unreadable", `Cannot read ${endpointPath}: ${err.message}`, {
      endpointPath,
    });
  }

  let endpoint;
  try {
    endpoint = JSON.parse(raw);
  } catch (err) {
    throw new BridgeError("bridge/endpoint-invalid", `Invalid JSON in ${endpointPath}: ${err.message}`, {
      endpointPath,
    });
  }
  if (!endpoint || typeof endpoint !== "object" || typeof endpoint.baseUrl !== "string") {
    throw new BridgeError("bridge/endpoint-invalid", `${endpointPath} has no string "baseUrl" field`, {
      endpointPath,
    });
  }

  let base;
  try {
    base = new URL(endpoint.baseUrl);
  } catch (err) {
    throw new BridgeError("bridge/endpoint-invalid", `Invalid baseUrl "${endpoint.baseUrl}": ${err.message}`, {
      baseUrl: endpoint.baseUrl,
    });
  }
  if (base.protocol !== "http:") {
    throw new BridgeError("bridge/not-loopback", `Refusing non-http baseUrl "${base.href}"`, { baseUrl: base.href });
  }
  if (!isLoopbackHost(base.hostname)) {
    throw new BridgeError(
      "bridge/not-loopback",
      `Refusing non-loopback baseUrl "${base.href}"; the bridge must listen on 127.0.0.1/localhost/::1.`,
      { baseUrl: base.href },
    );
  }
  // Relative resolution must treat baseUrl as a directory ("/agent-bridge" + "ping").
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;

  const tokenPath = endpoint.tokenPath ? path.resolve(String(endpoint.tokenPath)) : path.join(home, "token");
  let token;
  try {
    token = (await readFile(tokenPath, "utf8")).replace(/^\uFEFF/, "").trim();
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new BridgeError("bridge/not-ready", `Agent Bridge token file not found: ${tokenPath}`, {
        tokenPath,
        hint: "Same as above: the DSH agent-bridge plugin creates endpoint.json and token together.",
      });
    }
    throw new BridgeError("bridge/token-unreadable", `Cannot read ${tokenPath}: ${err.message}`, { tokenPath });
  }
  if (!token) throw new BridgeError("bridge/token-empty", `Token file is empty: ${tokenPath}`, { tokenPath });

  return {
    endpoint,
    baseUrl: base,
    endpointPath,
    token,
    tokenPath,
    displayBaseUrl: base.origin + base.pathname.replace(/\/$/, ""),
  };
}

/* ---------------------------------------------------------------- http call */

function httpJson(bridge, method, relativePath, body, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(relativePath, bridge.baseUrl);
    } catch (err) {
      reject(new BridgeError("bridge/bad-response", `Cannot build request URL: ${err.message}`));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${bridge.token}`,
    };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }

    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const req = httpRequest(
      {
        protocol: target.protocol,
        hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > RESPONSE_BODY_LIMIT) {
            res.destroy(new BridgeError("bridge/bad-response", "Response body too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          if (parsed && parsed.ok === true) {
            resolve(parsed.value);
            return;
          }
          if (parsed && parsed.ok === false && parsed.error && typeof parsed.error === "object") {
            reject(
              new BridgeError(
                typeof parsed.error.code === "string" ? parsed.error.code : "bridge/error",
                typeof parsed.error.message === "string" ? parsed.error.message : `HTTP ${res.statusCode}`,
                { httpStatus: res.statusCode },
              ),
            );
            return;
          }
          reject(
            new BridgeError(
              "bridge/bad-response",
              `Unexpected response from agent-bridge at ${method} ${target.pathname} (HTTP ${res.statusCode})`,
              { httpStatus: res.statusCode, bodyPreview: text.slice(0, 300) },
            ),
          );
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(
        new BridgeError("bridge/timeout", `agent-bridge did not answer ${method} ${target.pathname} within ${timeoutMs} ms`, {
          timeoutMs,
        }),
      );
    });
    req.on("error", (err) => {
      if (err instanceof BridgeError) {
        reject(err);
        return;
      }
      const code = err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") ? "bridge/not-ready" : "bridge/network-error";
      reject(
        new BridgeError(code, `Cannot reach agent-bridge at ${target.origin}: ${err.message}`, {
          cause: err.code || err.name,
          hint:
            err.code === "ECONNREFUSED"
              ? "The DSH app may have exited but left endpoint.json behind. Restart DeepSeek Harness."
              : undefined,
        }),
      );
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------- tool helpers */

function asString(value) {
  return typeof value === "string" ? value : "";
}

function requireString(args, key, maxLength = 512) {
  const value = asString(args[key]).trim();
  if (!value) throw badRequest(`"${key}" is required and must be a non-empty string`);
  if (value.length > maxLength) throw badRequest(`"${key}" is too long (max ${maxLength} chars)`);
  return value;
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit - 1)}\u2026`, truncated: true };
}

function toToolError(err) {
  if (err instanceof BridgeError) return err.toPayload();
  return {
    ok: false,
    code: "internal/error",
    message: err && err.message ? err.message : String(err),
  };
}

function jsonContent(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function errorContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: `DeepSeek Bridge error (${payload.code}): ${payload.message}${payload.hint ? `\nHint: ${payload.hint}` : ""}\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
    structuredContent: payload,
    isError: true,
  };
}

/* ---------------------------------------------------------------- tool impl */

async function toolDeepseekStatus(args) {
  const result = {
    ok: false,
    ready: false,
    server: { name: SERVER_NAME, version: SERVER_VERSION, pid: process.pid, node: process.version },
    bridgeHome: dshBridgeHome(),
    endpointPath: path.join(dshBridgeHome(), "endpoint.json"),
  };

  let bridge;
  try {
    bridge = await loadBridge();
  } catch (err) {
    return { ...result, error: toToolError(err) };
  }

  result.baseUrl = bridge.displayBaseUrl;
  result.workspaceRoot = typeof bridge.endpoint.workspaceRoot === "string" ? bridge.endpoint.workspaceRoot : null;
  result.protocol = typeof bridge.endpoint.protocol === "number" ? bridge.endpoint.protocol : null;

  try {
    const ping = await httpJson(bridge, "GET", "ping", undefined, PING_TIMEOUT_MS);
    result.ok = true;
    result.ready = true;
    result.ping = ping ?? null;
    if (ping && typeof ping.protocol === "number") result.protocol = ping.protocol;
  } catch (err) {
    return { ...result, error: toToolError(err) };
  }

  const warnings = [];
  try {
    const health = await httpJson(bridge, "GET", "health", undefined, HTTP_TIMEOUT_MS);
    if (health && typeof health === "object") {
      result.health = health;
      result.dsh = health.dsh ?? null;
      result.codex = health.codex ?? null;
      result.tasks = health.tasks ?? null;
      if (typeof health.workspaceRoot === "string") result.workspaceRoot = health.workspaceRoot;
    }
  } catch (err) {
    warnings.push(`health: ${toToolError(err).message}`);
  }

  try {
    const sessions = await httpJson(bridge, "GET", "sessions?limit=10", undefined, HTTP_TIMEOUT_MS);
    if (sessions && Array.isArray(sessions.sessions)) result.sessions = sessions.sessions;
  } catch (err) {
    warnings.push(`sessions: ${toToolError(err).message}`);
  }

  if (warnings.length) result.warnings = warnings;
  return result;
}

async function toolDeepseekTask(args) {
  const title = requireString(args, "title", 200);
  const summaryRaw = asString(args.summary);
  if (!summaryRaw.trim()) throw badRequest('"summary" is required: give the DSH agent a self-contained description of the task');

  const status = asString(args.status).trim().toUpperCase() || "DONE";
  if (!TASK_STATUSES.has(status)) {
    throw badRequest(`"status" must be one of ${[...TASK_STATUSES].join(", ")} (got "${args.status}")`);
  }

  const modeRaw = asString(args.mode).trim().toLowerCase();
  const mode = modeRaw ? modeRaw : "queue";
  if (!TASK_MODES.has(mode)) throw badRequest(`"mode" must be "queue" or "now" (got "${args.mode}")`);

  const refs = Array.isArray(args.refs) ? args.refs.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  const sessionId = asString(args.session ?? args.sessionId).trim();
  if (summaryRaw.length > SUMMARY_LIMIT) throw new BridgeError("request/too-large", `Summary length ${summaryRaw.length} characters exceeds current limit ${SUMMARY_LIMIT}; shorten it or provide file references; nothing sent.`, { currentLength: summaryRaw.length, limit: SUMMARY_LIMIT });
  const replyRequired = args.replyRequired !== false;
  const marker = /^\[Agent Bridge Reply-To: codex ([0-9a-f-]{36})\]$/imu.exec(summaryRaw)?.[1];
  const explicit = asString(args.replyThreadId).trim();
  if (explicit && marker && explicit.toLowerCase() !== marker.toLowerCase()) throw badRequest('Reply-To address conflict');
  const replyThreadId = explicit || marker;
  if (replyRequired && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(replyThreadId ?? '')) throw badRequest('replyThreadId must be your actual current Codex thread UUID, or provide the explicit Agent Bridge Reply-To marker; no PID/latest fallback');
  const summary = summaryRaw;
  const truncated = false;

  const requestId = `codex-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "")}-${randomUUID().slice(0, 8)}`;
  const body = {
    requestId,
    title,
    status,
    summary,
    mode,
    replyThreadId,
    replyRequired,
    replyTo: replyThreadId ? {side:"codex",threadId:replyThreadId} : null,
  };
  if (refs.length) body.refs = refs;
  if (sessionId) body.sessionId = sessionId;

  const bridge = await loadBridge();
  const value = await httpJson(bridge, "POST", "tasks/send", body);

  return {
    ok: true,
    requestId,
    taskId: value && value.taskId ? value.taskId : null,
    sessionId: value && value.sessionId ? value.sessionId : sessionId || null,
    accepted: value && typeof value.accepted === "boolean" ? value.accepted : null,
    replayed: value && typeof value.replayed === "boolean" ? value.replayed : undefined,
    status,
    mode,
    truncated,
    summaryChars: summary.length,
  };
}

async function toolDeepseekResult(args) {
  const taskId = requireString(args, "taskId", 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(taskId)) throw badRequest(`"taskId" contains unsupported characters: ${taskId}`);

  let waitMs = Number(args.waitMs ?? WAIT_DEFAULT_MS);
  if (!Number.isFinite(waitMs)) waitMs = WAIT_DEFAULT_MS;
  waitMs = Math.max(0, Math.min(WAIT_MAX_MS, Math.floor(waitMs)));

  const bridge = await loadBridge();
  await requirePushOnlyService(bridge);
  const taskPath = `tasks/${encodeURIComponent(taskId)}`;
  const value =
    waitMs > 0
      ? await httpJson(bridge, "POST", `${taskPath}/wait`, { waitMs }, waitMs + HTTP_TIMEOUT_MS)
      : await httpJson(bridge, "GET", taskPath, undefined, HTTP_TIMEOUT_MS);

  const task = value && typeof value === "object" ? value : {};
  const archiveAllowed = task.archiveAvailable === true && task.readPolicy === 'closed-archive';
  return {ok:true,...legacyResultView({...task,taskId:task.taskId ?? taskId,waitedMs:waitMs},archiveAllowed)};
}

async function toolDeepseekReportTurnEnd() { return {ok:true,delivered:false,reason:'disabled',readPolicy:'push-only-until-closed',note:'Legacy Stop reporting is disabled; no rollout read and no automatic message.'}; }

const TOOLS = [
  {
    name: "deepseek_task",
    title: "Send task to DeepSeek",
    description:
      "Hand a self-contained task to the local DeepSeek Harness (DSH) agent over 127.0.0.1. " +
      "Returns a transport taskId. DeepSeek must actively push replies to replyThreadId using codex_task; never read/poll an open conversation or report file. deepseek_result exposes status only until verified bilateral closure. " +
      "The DSH agent does not see this Codex conversation, so put every needed fact, path and constraint in `summary` " +
      "(<= 4000 chars; longer text is rejected without sending).",
    inputSchema: {
      type: "object",
      properties: {
        replyThreadId: { type: "string", description: "Your actual current Codex thread UUID for DeepSeek to push its reply. Required unless summary has an explicit Agent Bridge Reply-To marker; never PID/latest." },
        replyRequired: { type: "boolean", description: "False only for an explicitly no-reply notice; do not acknowledge closure notices." },
        title: { type: "string", description: "Short task title (max 200 chars)." },
        status: {
          type: "string",
          enum: ["DONE", "BLOCKED", "QUESTION", "INFO"],
          description:
            "Why you are handing this over. DONE = a finished result to apply; BLOCKED = you are stuck and need DSH; " +
            "QUESTION = you need an answer from the DSH agent; INFO = informational context.",
        },
        summary: {
          type: "string",
          description: "Self-contained task description / result summary (max 4000 chars).",
        },
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths, URLs or task ids the DSH agent should look at.",
        },
        session: {
          type: "string",
          description: "Optional target DSH session id (see deepseek_status.sessions).",
        },
        mode: {
          type: "string",
          enum: ["queue", "now"],
          description: "queue (default) delivers at the next turn boundary; now attempts immediate delivery.",
        },
      },
      required: ["title", "status", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_result",
    title: "DeepSeek task status or closed archive",
    description:
      "Read metadata-only state; never pull peer content before bilateral closure. Wait for DeepSeek to actively push its message. Closed tasks alone permit scoped archive reads. Read the state of a task previously sent with deepseek_task, optionally waiting up to 30 s for new activity. " +
      "waitMs defaults to 0 for an immediate status read; a positive value sends one POST /tasks/{id}/wait (maximum 30000 ms) to wait for state changes only. Open-task content remains filtered and reply=null. This is not a peer-reply wait. done is a completed turn, never bilateral closure. Do not repeatedly poll; peer results arrive by pushed message.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by deepseek_task." },
        waitMs: {
          type: "integer",
          minimum: 0,
          maximum: 30000,
          description: "Default 0; positive values make one metadata-only POST /tasks/{id}/wait (max 30000 ms). Open-task content remains filtered.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_status",
    title: "DeepSeek bridge status",
    description:
      "Check whether the local Agent Bridge is reachable, and read DSH health plus the recent DSH sessions list. " +
      "Call this first when a DeepSeek tool call fails.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deepseek_report_turn_end",
    title: "Report Codex turn end",
    description:
      "Disabled compatibility entry: no rollout reads, no automatic messages and no HTTP request. Never use it to answer closure notices.",
    inputSchema: {
      type: "object",
      properties: {
        hook_event_name: { type: "string", description: "Hook event name injected by Codex." },
        session_id: { type: "string", description: "Codex session id injected by Codex." },
        turn_id: { type: "string", description: "Codex turn id injected by Codex." },
      },
      additionalProperties: true,
    },
  },
];


const AGENT_SCHEMA = {
  "type": "object",
  "properties": {
    "agentKey": { "type": "string", "description": "Private capability returned once on first registration. Keep locally; never send to the other agent or commit to a repository." },
    "action": {
      "type": "string",
      "enum": [
        "register",
        "list",
        "get"
      ]
    },
    "sessionId": {
      "type": "string",
      "description": "Actual current host session ID; Codex uses its thread UUID, DeepSeek uses sessionController ID. Never guess latest."
    },
    "agentId": {
      "type": "string"
    },
    "alias": {
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
};
const TASK_SCHEMA = {
  "type": "object",
  "properties": {
    "agentKey": { "type": "string", "description": "Private capability returned once on first registration. Keep locally; never send to the other agent or commit to a repository." },
    "action": {
      "type": "string",
      "enum": [
        "create",
        "list",
        "get",
        "edit",
        "delete",
        "restore",
        "send",
        "refresh",
        "correct",
        "complete",
        "confirm",
        "close",
        "reopen",
        "import"
      ]
    },
    "actorId": {
      "type": "string"
    },
    "recipientId": {
      "type": "string"
    },
    "taskId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    },
    "requestId": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "content": {
      "type": "string"
    },
    "evidence": {
      "type": "string"
    },
    "verdict": {
      "type": "string",
      "enum": [
        "accepted",
        "rejected"
      ]
    },
    "reason": {
      "type": "string"
    },
    "includeDeleted": {
      "type": "boolean"
    },
    "legacyTaskId": {
      "type": "string"
    },
    "legacyDirection": {
      "type": "string",
      "enum": [
        "codex-to-deepseek",
        "deepseek-to-codex"
      ]
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
};
function validateV2(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw badRequest("Arguments must be an object");
  for (const key of schema.required) if (args[key] === undefined) throw badRequest(key + " is required");
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) throw badRequest("Unknown argument: " + key);
    const validType = field.type === "integer" ? Number.isInteger(value) : typeof value === field.type;
    if (!validType || (field.enum && !field.enum.includes(value)) || (field.minimum !== undefined && value < field.minimum)) throw badRequest("Invalid argument: " + key);
  }
}
async function toolBridgeAgent(args) {
  validateV2(args, AGENT_SCHEMA);
  if (args.action === "register" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.sessionId || "")) throw badRequest("register requires the actual Codex thread UUID as sessionId");
  return await httpJson(await loadBridge(), "POST", "v2/agent", { ...args, side: "codex" });
}
async function toolBridgeTask(args) {
  validateV2(args, TASK_SCHEMA);
  // Service owns action-specific required fields, identity, state and revision validation.
  const bridge = await loadBridge();
  await requirePushOnlyService(bridge);
  const value = await httpJson(bridge, "POST", "v2/task", { ...args, side: "codex" });
  return taskResultView(value, args.actorId);
}
async function requirePushOnlyService(bridge) {
  const health = await httpJson(bridge, "GET", "health");
  if (health?.readPolicy !== 'push-only-until-closed') throw new BridgeError('bridge/upgrade-required', '当前服务不支持未闭环正文保护；未请求任务内容。请升级并核对实际加载版本，等待对方主动发送消息，不改读报告。');
}
async function toolBridgeManual() {
  return { uri: "bridge://manual", text: await readFile(fileURLToPath(new URL("./MANUAL.md", import.meta.url)), "utf8") };
}
TOOLS.push(
 { name: "bridge_agent", title: "Bridge agent identity", description: "Register/list/get persistent routing identities. Caller must supply the actual current Codex thread UUID; this is not authenticated host session identity. Never guess latest. First registration returns agentKey once: keep it private locally, never send it to the other agent or write it to a repository. Existing alias changes require agentKey. Side is codex.", inputSchema: AGENT_SCHEMA },
 { name: "bridge_task", title: "Bridge task lifecycle", description: "Create/list/get/edit/delete/restore/send/refresh/correct/complete/confirm/close/reopen/import through authenticated HTTP. Open outputs omit peer content and evidence; never pull peer reports from files or transcripts. Wait for an actively pushed message; done is not closure. Every bridge_task action requires actorId and its private agentKey; keep the key locally, never send it to another agent or commit it. Deleting a bridge record is recoverable and does not retract delivered content or cancel recipient work. Sent content needs an explicit correct revision. Close only after bilateral confirmation; the closure notice uses replyRequired=false and must not receive subsequent automatic replies. Action-specific fields, ownership and expectedRevision are checked at runtime by the lifecycle service.", inputSchema: TASK_SCHEMA },
 { name: "bridge_manual", title: "Bridge manual", description: "Read packaged Codex manual, also available as bridge://manual.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
);

const HANDLERS = {
  bridge_agent: toolBridgeAgent,
  bridge_task: toolBridgeTask,
  bridge_manual: toolBridgeManual,
  deepseek_task: toolDeepseekTask,
  deepseek_result: toolDeepseekResult,
  deepseek_status: toolDeepseekStatus,
  deepseek_report_turn_end: toolDeepseekReportTurnEnd,
};

/* ------------------------------------------------------------ JSON-RPC loop */

function send(message) {
  if (!message || typeof message !== "object") return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function negotiateProtocolVersion(requested) {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

function handleInitialize(params) {
  const protocolVersion = negotiateProtocolVersion(params && params.protocolVersion);
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    serverInfo: {
      name: SERVER_NAME,
      title: "DeepSeek Bridge",
      version: SERVER_VERSION,
    },
    instructions:
      "DeepSeek Bridge relays tasks between Codex and a local DeepSeek Harness (DSH) agent over loopback HTTP. " +
      "Use deepseek_task to hand work to DSH, deepseek_result to collect the answer, deepseek_status to diagnose the link. " +
      "The two agents do not share conversation history: always make task summaries self-contained.",
  };
}

async function handleToolsCall(id, params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const handler = HANDLERS[name];
  if (!handler) {
    sendError(id, -32602, `Unknown tool: ${name}`, { availableTools: Object.keys(HANDLERS) });
    return;
  }
  try {
    const payload = await handler(args);
    if (name === "deepseek_status" && payload && payload.ok === false) {
      const nested = payload.error && typeof payload.error === "object" ? payload.error : {};
      sendResult(
        id,
        errorContent({
          ...payload,
          code: nested.code || "bridge/not-ready",
          message: nested.message || "Agent Bridge is not reachable",
          hint: nested.hint,
        }),
      );
      return;
    }
    if (name === "deepseek_report_turn_end" && payload && payload.error && !payload.ok) {
      // Hook path: report softly so a dead bridge cannot fail the Codex turn.
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: false,
      });
      return;
    }
    sendResult(id, jsonContent(payload));
  } catch (err) {
    const payload = toToolError(err);
    sendResult(id, errorContent(payload));
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    sendError(null, -32600, "Invalid Request");
    return;
  }
  const { id, method, params } = message;
  const expectsResponse = id !== undefined && id !== null;

  if (typeof method !== "string") {
    if (expectsResponse) sendError(id, -32600, "Invalid Request: missing method");
    return;
  }

  // Notifications (no id) are fire-and-forget; never answer them.
  if (!expectsResponse) {
    log(`notification ${method}`);
    return;
  }

  try {
    switch (method) {
      case "initialize":
        sendResult(id, handleInitialize(params));
        return;
      case "ping":
        sendResult(id, {});
        return;
      case "tools/list":
        sendResult(id, { tools: TOOLS });
        return;
      case "tools/call":
        await handleToolsCall(id, params);
        return;
      case "resources/list":
        sendResult(id, { resources: [{ uri: "bridge://manual", name: "Codex Agent Bridge manual", mimeType: "text/markdown" }] });
        return;
      case "resources/read": {
        if (params?.uri !== "bridge://manual") { sendError(id, -32602, "Unknown resource URI"); return; }
        const manual = await toolBridgeManual();
        sendResult(id, { contents: [{ uri: manual.uri, mimeType: "text/markdown", text: manual.text }] });
        return;
      }
      case "prompts/list":
        sendResult(id, { prompts: [] });
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, "Internal error", err && err.message ? err.message : String(err));
  }
}

function start() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let stdinClosed = false;

  const maybeExit = () => {
    if (stdinClosed && inFlight === 0) {
      log("stdin closed and all requests settled, exiting");
      process.exit(0);
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      log(`parse error: ${err.message}`);
      sendError(null, -32700, "Parse error: expected newline-delimited JSON-RPC 2.0");
      return;
    }
    // Track in-flight work so a closed stdin never truncates a response mid-flight.
    inFlight += 1;
    handleMessage(message)
      .catch((err) => {
        log(`handler crashed: ${err && err.stack ? err.stack : String(err)}`);
      })
      .finally(() => {
        inFlight -= 1;
        maybeExit();
      });
  });
  rl.on("close", () => {
    stdinClosed = true;
    log(`stdin closed, in-flight requests: ${inFlight}`);
    maybeExit();
  });
  process.stdout.on("error", (err) => {
    if (err && err.code === "EPIPE") process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[deepseek-bridge] uncaught: ${err && err.stack ? err.stack : String(err)}\n`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[deepseek-bridge] unhandled rejection: ${err && (err.stack || err)}\n`);
  });
  log(`started pid=${process.pid} node=${process.version} bridgeHome=${dshBridgeHome()}`);
}

start();
