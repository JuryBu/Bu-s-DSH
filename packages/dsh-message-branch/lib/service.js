import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { installModelSelection } from "@deepseek-ai/dsh-agent";

import {
  EXTERNAL_EFFECTS_WARNING,
  FILE_MANIFEST_MARKER,
  MESSAGE_BRANCH_SCHEMA_VERSION,
  extractDraftFromMessage,
  fileManifestText,
  findRealUserMessage,
  locateBranchPoint,
  locatePendingBranchPoint,
  normalizeDraftShape,
  normalizeFileDescriptor,
  normalizeInlineFile,
  normalizeInlineImage,
  normalizeModelSelection,
  requestDigest,
} from "./contract.js";
import { asFailure, branchError, MessageBranchError } from "./errors.js";
import { InternalReplayRegistry } from "./replay-registry.js";
import { assertRegularWorkspaceFiles } from "./store.js";
import { renderFileRestorationWarning, restoreTrackedFiles, trackedFilesAt } from "./tracked-files.js";

function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw branchError("invalid_attachment", "图片 dataBase64 不是合法 Base64");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function hasPending(agent) {
  return Boolean(agent?.inbox?.hasPending);
}

function eventDigest(events) {
  return `sha256:${createHash("sha256").update(JSON.stringify(events)).digest("hex")}`;
}

function stableAgent(agent) {
  if (!agent) return { allowed: false, reason: "session_not_found" };
  if (agent.status !== "idle") return { allowed: false, reason: "session_running" };
  if (hasPending(agent)) return { allowed: false, reason: "pending_input" };
  return { allowed: true, reason: "available" };
}

function selectTarget(agent, selector = {}) {
  const sourceMessageEvent = findRealUserMessage(agent.session.events, selector);
  if (!sourceMessageEvent) {
    const hasAnyRealMessage = findRealUserMessage(agent.session.events) !== undefined;
    return { allowed: false, reason: hasAnyRealMessage ? "message_not_found" : "no_real_user_message" };
  }
  return { allowed: true, reason: "available", sourceMessageEvent };
}

function createPreparingRecord({ operationId, requestDigestValue, sourceAgent, sourceMessageEvent, snapshot, images, files, modelSelection, now }) {
  const timestamp = now();
  return {
    schemaVersion: MESSAGE_BRANCH_SCHEMA_VERSION,
    operationId,
    state: "preparing",
    parentSessionId: sourceAgent.id,
    sourceMessageId: sourceMessageEvent.data.id,
    sourceEventSeq: sourceMessageEvent.seq,
    sourceTurn: snapshot.sourceTurn,
    branchPointSeq: snapshot.branchPointSeq,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotHistorySha256: snapshot.historySha256,
    participantIds: snapshot.participants.map(item => item.id),
    attachments: { images, files },
    ...(modelSelection === undefined ? {} : { modelSelection }),
    externalEffects: "preserved",
    requestDigest: requestDigestValue,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class MessageBranchService {
  constructor({
    agents,
    agentPresets,
    workspaceRegistry,
    attachments,
    sessions,
    createUserMessage,
    sessionIdFactory = () => `session-branch-${randomUUID()}`,
    store,
    snapshotStore,
    replayRegistry = new InternalReplayRegistry(),
    emitState = () => {},
    observerError = () => {},
    now = () => new Date().toISOString(),
    acceptanceTimeoutMs = 5000,
  }) {
    if (!agents || typeof agents.get !== "function" || typeof agents.create !== "function") {
      throw branchError("invalid_config", "消息分支插件需要 agents 服务");
    }
    if (!store) throw branchError("invalid_config", "消息分支插件需要持久 sidecar store");
    if (typeof createUserMessage !== "function") throw branchError("invalid_config", "消息分支插件需要 createUserMessage");
    this.agents = agents;
    this.agentPresets = agentPresets;
    this.workspaceRegistry = workspaceRegistry;
    this.attachments = attachments;
    this.sessions = sessions;
    this.createUserMessage = createUserMessage;
    this.sessionIdFactory = sessionIdFactory;
    this.store = store;
    this.snapshotStore = snapshotStore;
    this.replayRegistry = replayRegistry;
    this.emitState = emitState;
    this.observerError = observerError;
    this.now = now;
    this.acceptanceTimeoutMs = acceptanceTimeoutMs;
    this.handles = new Map();
  }

  registerReplayParticipant(participant) {
    return this.replayRegistry.register(participant);
  }

  async captureIncomingMessages({ agent, messages, turn, signal }) {
    if (!this.snapshotStore || !Array.isArray(messages)) return;
    for (const message of messages) {
      if (message?.source?.kind !== "user" || typeof message.id !== "string" || message.id === "") continue;
      if (await this.snapshotStore.read(agent.id, message.id)) continue;
      const branch = locatePendingBranchPoint(agent.session.events, turn);
      const participants = await this.replayRegistry.captureAll({
        sourceAgent: agent,
        sourceSession: agent.session,
        sourceMessage: message,
        branchPointSeq: branch.branchPointSeq,
        signal,
      });
      await this.snapshotStore.save({
        schemaVersion: 1,
        sessionId: agent.id,
        messageId: message.id,
        sourceTurn: branch.sourceTurn,
        branchPointSeq: branch.branchPointSeq,
        seed: structuredClone(branch.seed),
        historySha256: eventDigest(branch.seed),
        header: structuredClone(agent.session.header),
        agentOptions: structuredClone(agent.options ?? {}),
        requestHeader: structuredClone(agent.session.requestHeader?.()),
        requestContext: structuredClone(agent.session.requestContext?.()),
        contextGenerationId: agent.contextGenerationId,
        participants,
        trackedFiles: trackedFilesAt(branch.seed, agent.session.header?.cwd),
        createdAt: this.now(),
      });
    }
  }

  async availability(sessionId, selector = {}) {
    const agent = this.agents.get(sessionId);
    let stable;
    try {
      stable = stableAgent(agent);
    } catch (error) {
      if (error instanceof MessageBranchError) return { allowed: false, reason: error.code };
      throw error;
    }
    if (!stable.allowed) return stable;
    const target = selectTarget(agent, selector);
    if (!target.allowed) return target;
    const snapshot = await this.snapshotFor(agent, target.sourceMessageEvent);
    if (!snapshot) return { allowed: false, reason: "snapshot_missing" };
    const storeWarnings = [];
    let prior;
    try {
      prior = await this.store.findByEditedMessageId(target.sourceMessageEvent.data.id, {
        onInvalid: error => {
          storeWarnings.push({ code: error.code ?? "branch_store_corrupt", message: error.message });
          this.observerError(error);
        },
      });
    } catch (error) {
      this.observerError(error);
      if (error instanceof MessageBranchError) {
        return {
          allowed: false,
          reason: error.code,
          warnings: [...storeWarnings, { code: error.code, message: error.message }],
        };
      }
      throw error;
    }
    return {
      allowed: true,
      reason: "available",
      sessionId: agent.id,
      sourceMessageId: target.sourceMessageEvent.data.id,
      sourceEventSeq: target.sourceMessageEvent.seq,
      sourceTurn: snapshot.sourceTurn,
      ...(typeof snapshot.requestContext?.provider === "string" && snapshot.requestContext.provider !== ""
        && typeof snapshot.requestContext?.model === "string" && snapshot.requestContext.model !== "" ? {
          modelSelection: {
            provider: snapshot.requestContext.provider,
            model: snapshot.requestContext.model,
            ...(typeof snapshot.requestContext.reasoningEffort === "string" && snapshot.requestContext.reasoningEffort !== ""
              ? { reasoningEffort: snapshot.requestContext.reasoningEffort }
              : {}),
          },
        } : {}),
      draft: extractDraftFromMessage(target.sourceMessageEvent.data, prior?.attachments?.files ?? []),
      ...(storeWarnings.length === 0 ? {} : { warnings: storeWarnings }),
    };
  }

  async snapshotFor(agent, sourceMessageEvent, signal) {
    if (this.snapshotStore) return this.snapshotStore.read(agent.id, sourceMessageEvent.data.id);
    const branch = locateBranchPoint(agent.session.events, sourceMessageEvent);
    const participants = await this.replayRegistry.captureAll({
      sourceAgent: agent,
      sourceSession: agent.session,
      sourceMessageEvent,
      branchPointSeq: branch.branchPointSeq,
      signal,
    });
    return {
      schemaVersion: 1,
      sessionId: agent.id,
      messageId: sourceMessageEvent.data.id,
      sourceTurn: branch.sourceTurn,
      branchPointSeq: branch.branchPointSeq,
      seed: structuredClone(branch.seed),
      historySha256: eventDigest(branch.seed),
      header: structuredClone(agent.session.header),
      agentOptions: structuredClone(agent.options ?? {}),
      requestHeader: structuredClone(agent.session.requestHeader?.()),
      requestContext: structuredClone(agent.session.requestContext?.()),
      contextGenerationId: agent.contextGenerationId,
      participants,
      trackedFiles: trackedFilesAt(branch.seed, agent.session.header?.cwd),
      createdAt: this.now(),
    };
  }

  async editAndResend(request) {
    if (!request || typeof request !== "object") throw branchError("invalid_request", "消息分支请求必须是对象");
    const operationId = typeof request.operationId === "string" ? request.operationId.trim() : "";
    const sessionId = typeof request.sessionId === "string" ? request.sessionId : "";
    const expectedSourceMessageId = typeof request.expectedSourceMessageId === "string" ? request.expectedSourceMessageId : "";
    if (!operationId || !sessionId || !expectedSourceMessageId) {
      throw branchError("invalid_request", "operationId、sessionId 和 expectedSourceMessageId 都不能为空");
    }
    const rawDraft = normalizeDraftShape(request.draft);
    const modelSelection = normalizeModelSelection(request.modelSelection);
    const sourceAgent = this.agents.get(sessionId);
    if (!sourceAgent) throw branchError("session_not_found", `找不到源会话：${sessionId}`);
    const sourceEventSeq = request.sourceEventSeq;
    if (sourceEventSeq !== undefined && (!Number.isSafeInteger(sourceEventSeq) || sourceEventSeq < 0)) {
      throw branchError("invalid_request", "sourceEventSeq 必须是非负整数");
    }
    const digestInput = { sessionId, expectedSourceMessageId, sourceEventSeq, draft: rawDraft, modelSelection };
    const digest = requestDigest(digestInput);
    const existing = await this.store.read(operationId);
    if (existing) {
      if (existing.requestDigest !== digest) throw branchError("operation_conflict", "相同 operationId 对应了不同请求", { operationId });
      if (existing.state === "created") return this.resultFromRecord(existing, true);
      if (existing.state === "preparing") throw branchError("operation_incomplete", "同一操作上次停在 preparing，拒绝猜测是否已经产生副作用", { operationId });
      throw branchError(existing.failure?.code ?? "operation_failed", existing.failure?.message ?? "同一操作已经失败", { operationId });
    }

    const prepared = await sourceAgent.runMaintenance(async signal => {
      const stable = stableAgent(sourceAgent);
      if (!stable.allowed) throw branchError(stable.reason, "源会话当前不允许编辑并重发");
      const target = selectTarget(sourceAgent, { messageId: expectedSourceMessageId, sourceEventSeq });
      if (!target.allowed) throw branchError(target.reason === "no_real_user_message" ? "no_real_user_message" : "stale_source_message", "目标历史消息已变化或不再存在", { expectedSourceMessageId, sourceEventSeq });
      const sourceMessageEvent = structuredClone(target.sourceMessageEvent);
      const sourceMessageIdentity = {
        id: sourceMessageEvent.data.id,
        seq: sourceMessageEvent.seq,
        digest: eventDigest([sourceMessageEvent]),
      };
      const snapshot = await this.snapshotFor(sourceAgent, sourceMessageEvent, signal);
      if (!snapshot) throw branchError("snapshot_missing", "无法从这条消息重新发送：该轮发送前的历史状态快照缺失");
      if (eventDigest(snapshot.seed) !== snapshot.historySha256) throw branchError("snapshot_corrupt", "该轮历史状态快照的会话前缀校验失败");
      const images = await this.admitImages(rawDraft.images);
      const files = await this.admitFiles(rawDraft.files, sourceAgent.session.header.cwd, operationId);
      const record = createPreparingRecord({
        operationId,
        requestDigestValue: digest,
        sourceAgent,
        sourceMessageEvent,
        snapshot,
        images,
        files,
        modelSelection,
        now: this.now,
      });
      await this.persistAndPublish(record);
      return {
        sourceAgent,
        sourceMessageEvent,
        sourceMessageIdentity,
        snapshot,
        rawDraft,
        images,
        files,
        record,
        modelSelection,
      };
    });
    return this.createBranch(prepared);
  }

  async admitImages(images) {
    const normalized = images.map(normalizeInlineImage);
    const admitted = [];
    for (const image of normalized) {
      if (image.kind === "reference") {
        admitted.push(image.attachment);
        continue;
      }
      if (!this.attachments) throw branchError("attachment_service_unavailable", "当前部署没有图片附件服务");
      const input = { data: decodeBase64(image.dataBase64), mediaType: image.mediaType };
      if (image.name !== undefined) input.name = image.name;
      await this.attachments.validateImage(input);
      admitted.push(await this.attachments.saveImage(input));
    }
    return admitted;
  }

  async admitFiles(files, cwd, operationId) {
    const normalized = files.map(file => normalizeInlineFile(file, cwd));
    const references = normalized.filter(file => file.kind === "reference").map(file => file.file);
    const admitted = await assertRegularWorkspaceFiles(references);
    const inline = normalized.filter(file => file.kind === "inline");
    if (inline.length === 0) return admitted;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw branchError("workspace_unavailable", "源会话没有可写入附件的绝对工作区路径");
    const directory = path.join(cwd, ".dsh", "message-branch-uploads", createHash("sha256").update(operationId).digest("hex"));
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < inline.length; index += 1) {
      const file = inline[index];
      const data = decodeBase64(file.dataBase64);
      if (data.length > 16 * 1024 * 1024) throw branchError("invalid_attachment", "普通文件超过 16 MiB 上限", { name: file.name });
      const target = path.join(directory, `${String(index + 1).padStart(3, "0")}-${file.name}`);
      try {
        await writeFile(target, data, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const current = await readFile(target);
        if (!current.equals(Buffer.from(data))) throw branchError("operation_conflict", "相同操作编号对应的上传文件内容不同", { name: file.name });
      }
      admitted.push({ name: file.name, mediaType: file.mediaType, bytes: data.length, workspacePath: target });
    }
    return admitted;
  }

  buildMessage(draft, images, files, sourceContent = [], surfaceReplace) {
    const content = [];
    const text = draft.text.trim() === "" ? undefined : { type: "text", text: draft.text };
    const manifest = fileManifestText(files);
    let placedText = false;
    const placedImages = new Set();
    let placedManifest = false;
    const placeText = () => {
      if (text === undefined || placedText) return;
      content.push(text);
      placedText = true;
    };
    const placeImage = (index) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= images.length || placedImages.has(index)) return;
      content.push({ type: "image", attachment: images[index] });
      placedImages.add(index);
    };
    const placeImages = () => {
      for (let index = 0; index < images.length; index += 1) placeImage(index);
    };
    const placeManifest = () => {
      if (manifest === undefined || placedManifest) return;
      content.push({ type: "text", text: manifest });
      placedManifest = true;
    };
    if (Array.isArray(draft.order)) {
      for (const item of draft.order) {
        if (item?.type === "image") placeImage(item.index);
        else if (item?.type === "file") placeManifest();
        else if (item?.type === "text") placeText();
      }
    } else {
      for (const block of Array.isArray(sourceContent) ? sourceContent : []) {
        if (block?.type === "image") placeImages();
        else if (block?.type === "text" && typeof block.text === "string") {
          if (block.text.startsWith(FILE_MANIFEST_MARKER)) placeManifest();
          else placeText();
        }
      }
    }
    placeText();
    placeImages();
    placeManifest();
    return this.createUserMessage({
      content,
      source: { kind: "user" },
      ...(surfaceReplace === undefined ? {} : { dshSurfaceReplace: surfaceReplace }),
    });
  }

  assertCommitStillValid(sourceAgent, expectedMessageId, expectedSourceEventSeq, expectedMessageDigest) {
    if (sourceAgent.status !== "idle") throw branchError("session_running", "发布分支前源会话不再空闲");
    if (hasPending(sourceAgent)) throw branchError("pending_input", "发布分支前源会话出现了待处理输入");
    const current = findRealUserMessage(sourceAgent.session.events, {
      messageId: expectedMessageId,
      sourceEventSeq: expectedSourceEventSeq,
    });
    if (!current || eventDigest([current]) !== expectedMessageDigest) {
      throw branchError("stale_source_message", "发布分支前目标历史消息已经变化");
    }
  }

  resolveWorkspace(sessionId) {
    return this.workspaceRegistry?.list?.().find(workspace => workspace.sessionIds.includes(sessionId));
  }

  async createBranch({ sourceAgent, sourceMessageEvent, sourceMessageIdentity, snapshot, rawDraft, images, files, record, modelSelection }) {
    const sourceHeader = snapshot.header ?? sourceAgent.session.header;
    const surfaceNodes = [...sourceAgent.session.surface.nodes];
    const replaceStart = surfaceNodes.indexOf(sourceMessageEvent.seq);
    if (replaceStart < 0) throw branchError("stale_source_message", "目标历史消息已经不在当前对话分支中");
    const replacedSeqs = surfaceNodes.slice(replaceStart);
    const editedMessage = this.buildMessage(rawDraft, images, files, sourceMessageEvent.data.content, {
      start: replacedSeqs[0],
      end: replacedSeqs.at(-1),
      sourceEventSeqs: replacedSeqs,
    });
    let fileRestoration;
    try {
      await sourceAgent.runMaintenance(async maintenanceSignal => {
        maintenanceSignal.throwIfAborted();
        this.assertCommitStillValid(
          sourceAgent,
          sourceMessageIdentity.id,
          sourceMessageIdentity.seq,
          sourceMessageIdentity.digest,
        );
        fileRestoration = await restoreTrackedFiles(snapshot.trackedFiles, sourceHeader.cwd);
        await this.replayRegistry.restoreAll(snapshot.participants, {
          childCtx: sourceAgent.ctx,
          childSessionId: sourceAgent.id,
          parentSessionId: sourceAgent.id,
          branchPointSeq: snapshot.branchPointSeq,
          signal: maintenanceSignal,
        });
        if (modelSelection !== undefined) {
          installModelSelection(sourceAgent.ctx, { current: modelSelection, assembled: undefined });
        }
        sourceAgent.followup(editedMessage);
      });
      await this.waitForMessage(sourceAgent, editedMessage.id);
      await this.sessions?.flush?.(sourceAgent.session);
      const created = {
        ...record,
        state: "created",
        childSessionId: sourceAgent.id,
        editedMessageId: editedMessage.id,
        fileRestoration: {
          restored: fileRestoration.restored,
          conflicts: fileRestoration.conflicts,
        },
        updatedAt: this.now(),
      };
      await this.persistAndPublish(created);
      return this.resultFromRecord(created, false);
    } catch (error) {
      await fileRestoration?.rollback().catch(rollbackError => this.observerError(rollbackError));
      const failed = {
        ...record,
        state: "failed",
        updatedAt: this.now(),
        failure: asFailure(error),
      };
      await this.persistAndPublish(failed).catch(storeError => this.observerError(storeError));
      throw error;
    }
  }

  async waitForMessage(agent, messageId, signal) {
    const deadline = Date.now() + this.acceptanceTimeoutMs;
    while (!agent.session.events.some(event => event.type === "user/message" && event.data?.id === messageId)) {
      if (signal?.aborted) throw signal.reason ?? branchError("aborted", "消息分支操作已取消");
      if (Date.now() >= deadline) throw branchError("message_acceptance_timeout", "编辑后的消息未在期限内进入当前会话日志");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async persistAndPublish(record) {
    const saved = await this.store.save(record);
    try {
      await this.emitState(structuredClone(saved));
    } catch (error) {
      this.observerError(error);
    }
    return saved;
  }

  resultFromRecord(record, idempotent) {
    return {
      operationId: record.operationId,
      state: record.state,
      parentSessionId: record.parentSessionId,
      childSessionId: record.childSessionId,
      sourceMessageId: record.sourceMessageId,
      editedMessageId: record.editedMessageId,
      branchPointSeq: record.branchPointSeq,
      fileRestoration: record.fileRestoration ?? { restored: [], conflicts: [] },
      externalEffects: "preserved",
      idempotent,
    };
  }

  async dispose() {
    for (const [sessionId, handle] of [...this.handles].reverse()) {
      await handle.dispose().catch(error => this.observerError(error));
      this.handles.delete(sessionId);
    }
  }
}
