import type {
  ThreadListRequest,
  ThreadListResult,
  ThreadReadRequest,
  ThreadReadResult,
  ThreadSearchRequest,
  ThreadSearchResult,
  ThreadToolsHost,
} from "./types.ts";

/** Model-tool names intentionally mirror the planned DSH native surface. */
export class ThreadToolsService {
  private readonly host: ThreadToolsHost;

  constructor(host: ThreadToolsHost) {
    this.host = host;
  }

  thread_list(request: ThreadListRequest = {}): Promise<ThreadListResult> {
    return this.host.listThreads(request);
  }

  thread_search(request: ThreadSearchRequest): Promise<ThreadSearchResult> {
    return this.host.searchThreads(request);
  }

  thread_read(request: ThreadReadRequest): Promise<ThreadReadResult> {
    return this.host.readThread(request);
  }
}
