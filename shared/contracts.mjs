export const AGENT_SCHEMA = {
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
export const TASK_SCHEMA = {
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
