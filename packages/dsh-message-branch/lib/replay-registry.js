import { branchError } from "./errors.js";

export class InternalReplayRegistry {
  constructor() {
    this.participants = new Map();
  }

  register(participant) {
    if (!participant || typeof participant !== "object") throw branchError("invalid_participant", "回放参与者必须是对象");
    if (typeof participant.id !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(participant.id)) {
      throw branchError("invalid_participant", "回放参与者 id 格式无效");
    }
    if (typeof participant.capture !== "function" || typeof participant.restore !== "function") {
      throw branchError("invalid_participant", "回放参与者必须实现 capture 和 restore");
    }
    if (this.participants.has(participant.id)) throw branchError("duplicate_participant", `回放参与者重复：${participant.id}`);
    this.participants.set(participant.id, participant);
    return () => this.participants.delete(participant.id);
  }

  ids() {
    return [...this.participants.keys()].sort();
  }

  async captureAll(context) {
    const captures = [];
    for (const id of this.ids()) {
      const participant = this.participants.get(id);
      const snapshot = await participant.capture(context);
      let detached;
      try {
        detached = structuredClone(snapshot);
      } catch (error) {
        throw branchError("participant_capture_invalid", `回放参与者 ${id} 返回了不可复制快照`, { cause: String(error) });
      }
      captures.push({ id, snapshot: detached });
    }
    return captures;
  }

  async restoreAll(captures, context) {
    for (const capture of captures) {
      const participant = this.participants.get(capture.id);
      if (participant === undefined) {
        throw branchError("participant_unavailable", `回放参与者 ${capture.id} 在恢复时不可用`);
      }
      await participant.restore({ ...context, snapshot: structuredClone(capture.snapshot) });
    }
  }
}
