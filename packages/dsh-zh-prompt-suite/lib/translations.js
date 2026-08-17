function sourcePathTranslation(text) {
  const sourceRoot = text.match(/checkout is at (.+?)\. The checkout location/)?.[1];
  return sourceRoot === undefined
    ? "DeepSeek Harness 的实现源码路径由当前运行环境提供。它与会话工作目录是两个独立位置，不要互相推断；只有在开发或检查 DSH 本身时才使用该源码。维护 DSH 时先分清源码工作区、生产运行 release 和用户数据目录，长期修改只写源码区，生产产物和用户数据只用于验证。"
    : `DeepSeek Harness 的实现源码位于 ${sourceRoot}。这是 DSH 自身长期修改入口，不等于当前会话工作目录；需要当前工作目录时使用相应工具确认。维护 DSH 时先分清源码工作区、生产运行 release 和用户数据目录，长期修改只写源码区，生产产物和用户数据只用于验证。`;
}

function webSurfaceTranslation(text) {
  const webUrl = text.match(/Web GUI at (https?:\/\/\S+?)\./)?.[1] ?? "当前 DSH 地址";
  return `你正在通过 DeepSeek Harness 图形界面 ${webUrl} 与主人交互。主人没有另行指定目标时，“这个页面”“这个界面”“这个应用”都指当前 DSH 界面。浏览器不会自动把 DOM、路由或截图交给你，必须使用相应工具检查。只有从同一源码目录运行前端开发监听时，客户端插件修改才可能无刷新更新；其它前端修改需要重新构建受影响产物并刷新这个既有地址验证。另起一个服务器不会更新当前界面，除非主人明确要求，不要启动替代服务器。`;
}

const SECTION_TRANSLATIONS = new Map([
  ["harness:identity", "你是由 DeepSeek Harness 驱动的 AI 智能体。"],
  ["harness:source", sourcePathTranslation],
  ["app:web-surface", webSurfaceTranslation],
  ["ui:deliverable-file-references", "最终回复提到主要交付文件时，使用文件工具返回的精确路径，方便 DSH 界面生成可点击的文件引用。不要编造或缩写路径。"],
  ["plan:policy", "当前处于计划模式。在计划获批前，只做只读调查，并只询问真正阻塞方案的问题。准备好后调用 exit_plan_mode 提交完整可执行计划，并把该调用作为本轮唯一且最后一个工具调用。只有主人在审批界面正式批准、进入后续轮次后才能实施；普通回复、口头同意或回答问题都不等于批准。"],
  ["tool:read", "主力模式默认优先使用 Sandbox 读取和搜索本机文件；只有 Sandbox 不适用或明确不可达时才使用 read，不能因为文件小或只读就跳过 Sandbox。Sandbox 返回 admission_timeout 或“等待资源超时”只表示命令尚未开始，不算不可达；应按建议重试一次、降低内存、拆小或转后台，不能立即改用 read。回退使用 read 时，大文件通过 offset 和 limit 分段读取。"],
  ["tool:write", "使用 write 新建文件或完整替换文件内容。覆盖已有文件前先读取最新内容；只修改局部时优先使用当前可见的定点编辑工具。"],
  ["tool:edit", "edit 只做字面量替换：默认 old_string 必须唯一匹配；出现多处时提供更具体的原文，或在确实要全部替换时使用 replace_all。修改已有文件前先读取最新内容。"],
  ["tool:glob", "默认优先使用 Sandbox 搜索。只有 Sandbox 不适用或明确不可达时，才用 glob 按路径模式查找文件；admission_timeout 或等待资源超时不是不可达，先按建议重试一次、降低内存、拆小或转后台。没有斜杠的模式会匹配任意层级的文件名，结果只含文件并可包含隐藏或被忽略文件。"],
  ["tool:grep", "默认优先使用 Sandbox 搜索。只有 Sandbox 不适用或明确不可达时，才用 grep 搜索文件内容；admission_timeout 或等待资源超时不是不可达，先按建议重试一次、降低内存、拆小或转后台。需要命中位置周围上下文时再读取对应文件。"],
  ["tool:pwsh", "默认优先使用 Sandbox MCP；只有 Sandbox 不适用、明确不可达，或任务依赖当前 Windows Shell 时才使用 pwsh。每次检查退出码；非零退出先查明原因。Windows 进程被终止时可能只显示退出码 1，应结合是否刚发生中断判断。"],
  ["tool:bash", "默认优先使用 Sandbox MCP；只有 Sandbox 不适用或明确不可达时才使用 bash。每次检查退出码，失败后先查明原因再继续。"],
  ["tool:jobs", "记录自己启动的每个后台任务编号。任务完成后运行时会通知，不要靠频繁轮询或 sleep 等待；等待期间继续处理独立工作，也不要重复执行同一任务。最终回复前收回仍相关的结果，并停止已经不再需要的任务。"],
  ["tool:goal", "Goal 只用于主人明确要求跨轮持续推进的长期目标，普通单轮任务不要创建。更新前先读取当前 Goal；只有目标真正完成时才能标记完成，同一阻塞条件连续至少三个 Goal 轮次仍存在时才能标记阻塞。"],
  ["tool:subagent", "子代理默认在后台运行。互相独立的委派可以同时发出，等待期间继续推进不冲突的工作；只有下一步必须依赖子代理结果时才同步等待。派发时写清范围、材料、允许修改位置、验证与证据要求，并禁止子代理继续派发下一层。"],
  ["tool:workflow", "只有主人明确要求工作流，或任务确实需要大量子代理分阶段编排时才使用 workflow。一个或两个有界委派直接使用普通子代理。"],
  ["tool:ralph", "只有主人明确要求 Ralph 循环或多轮新代理接力时才使用 ralph。普通长期推进使用 Goal，有界委派和并行分工使用子代理或工作流。每轮 Ralph 都是没有对话种子的全新子代理，工作区文件才是持久状态；完成或阻塞报告不等于独立验收。"],
  ["tool:report", "结束前必须使用 report 向直接派发者提交一份可以独立理解的结果；带回结论、共享文件路径、验证证据、未检查范围和不确定点。只有“完成了”之类短句不能作为结果。阶段发现会改变主代理下一步时也应提前报告；report 不会自动结束当前轮次。"],
  ["tool:web_search", "优先使用已配置的 Exa 搜索当前公开信息；原生 web_search 只作轻量后备。使用搜索结果时引用相关网址，需要正文时再使用 Exa 抓取、web-fetcher 或当前可见的正文读取工具。"],
  ["tool:web_fetch", "优先使用 Exa 正文抓取或 web-fetcher；原生 web_fetch 只作公开网页文本的轻量后备。使用页面内容时引用原网址。"],
  ["tools:code-only", "只有 run_code 可以直接调用；直接调用其它工具会失败。要使用下方 SDK 中声明的工具，必须在 run_code 程序内部调用。简单单次操作不要包进 run_code；编排多项操作时，把命令、路径和正文作为独立参数传入，避免把含反引号、模板占位符或多层引号的长 PowerShell 直接塞进 TypeScript 模板字符串。"],
]);

function sandboxPolicyTranslation(text) {
  if (text.includes("danger-full-access")) {
    return "当前 DSH 原生文件权限为完全访问：DSH 自带文件沙箱不限制当前可见操作修改文件。这只描述 DSH 原生后备工具，不代表 Sandbox MCP 或其它外部工具的权限。";
  }
  if (text.includes("workspace-write")) {
    const root = text.match(/session workspace: (.+?)\. Some platform/)?.[1] ?? "当前会话工作区";
    return `当前 DSH 原生文件权限为工作区可写：当前可见且受 DSH 文件沙箱约束的操作可以修改 ${root} 内的文件，部分系统临时目录也可能可写。这只描述 DSH 原生后备工具，不代表 Sandbox MCP 或其它外部工具的权限。`;
  }
  if (text.includes("read-only")) {
    return "当前 DSH 原生文件权限为只读：受 DSH 文件沙箱约束的操作不能直接修改文件。不要仅凭这条状态提前拒绝主人要求；正常调用当前可见工具，并按工具返回的拒绝或审批说明处理。这只描述 DSH 原生后备工具，不代表 Sandbox MCP 或其它外部工具的权限。";
  }
  return `当前 DSH 原生文件权限状态：${text}`;
}

function approvalPolicyTranslation(text) {
  if (text.includes("disabled") || text.includes("rejected automatically")) {
    return "当前 DSH 原生审批已关闭：需要审批的操作会自动拒绝，不要请求 DSH 沙箱提权，也不要设置 sandbox_permissions。外部 MCP 各自遵守自己的审批和授权边界。";
  }
  if (text.includes("policy: ask")) {
    return "当前 DSH 原生审批策略为询问：需要审批的操作可以通过已配置的审批通道请求主人决定；没有可用审批通道时必须拒绝。外部 MCP 各自遵守自己的审批和授权边界。";
  }
  return `当前 DSH 原生审批状态：${text}`;
}

const CONTEXT_TRANSLATIONS = new Map([
  ["sandbox:policy", sandboxPolicyTranslation],
  ["approval:policy", approvalPolicyTranslation],
  ["subagent:delegation", "你是主智能体派出的子代理。启动时确定的权限范围不能在本会话内扩大，需要审批的操作会自动拒绝；被权限阻止时不要重复尝试，应说明限制并交回主智能体处理。只完成委派范围内的工作，结束前带回检查范围、文件位置、关键输出、未检查范围和不确定点。"],
]);

const TOOL_DESCRIPTIONS = new Map([
  ["read", "分段读取 UTF-8 文本文件并返回带行号内容。主力模式仅在 Sandbox 不适用或明确不可达时使用。"],
  ["read_image", "读取 PNG、JPEG、WebP 或 GIF 图片，并把图像本身交给当前模型。只有模型确认支持视觉输入时使用。"],
  ["write", "新建 UTF-8 文本文件，或在明确需要时完整替换现有文件。"],
  ["edit", "通过字面量替换修改一个已有 UTF-8 文本文件。自定义主力模式应改用 apply_patch；本工具只保留给官方救援模式。"],
  ["glob", "按路径模式查找文件，不返回目录。DSH 自定义主力模式仅在 Sandbox 搜索不适用时使用。"],
  ["grep", "使用 Ripgrep 正则表达式搜索文件内容。需要查看上下文时再读取命中文件；自定义主力模式优先使用 Sandbox 搜索。"],
  ["pwsh", "启动一次独立的 PowerShell 命令。默认优先使用 Sandbox MCP；只有 Sandbox 不适用、明确不可达或任务依赖当前 Windows Shell 时才回退到本工具。"],
  ["bash", "启动一次 Bash 命令。默认优先使用 Sandbox MCP；只有 Sandbox 不适用或明确不可达时才回退到本工具。"],
  ["job_output", "读取后台任务的新输出或最终结果。可选择短暂等待；返回状态不等于外部副作用已经验证。"],
  ["job_list", "列出当前智能体拥有的后台任务及其状态。"],
  ["job_kill", "请求停止一个仍在运行的后台任务。请求成功不等于进程已经停止，需继续核对最终状态。"],
  ["ask_user_question", "在继续前向主人提出一到三个确实需要其决定的结构化问题。能从文件、日志或运行状态确认的事实不要反问。"],
  ["todo_write", "用完整列表替换当前短期任务看板，展示眼下准备做什么和已经完成什么。它不替代长期 Plan/Task。"],
  ["create_goal", "只在主人明确要求跨轮持续推进一个长期目标时创建 Goal。普通单轮任务不要创建。"],
  ["get_goal", "读取当前 Goal 的目标、状态、轮次与版本。"],
  ["update_goal", "更新当前 Goal 的生命周期状态。只有真正完成时才能标记完成，连续至少三个 Goal 轮次受同一条件阻塞时才能标记阻塞。"],
  ["exit_plan_mode", "提交完整可执行计划供主人正式审批。它必须是本次回复唯一且最后一个工具调用；审批通过后的后续轮次才能开始实施。"],
  ["skill", "按名称加载一个已安装 Skill 的完整说明。只加载与当前任务直接相关的 Skill。"],
  ["subagent", "派发一个独立子任务给后台子代理。写清目标、边界、材料、允许修改范围、验证方法和证据要求；子代理不得继续派发下一层代理。"],
  ["subagent_fork", "从当前上下文分叉一个独立子代理。只在继承当前讨论确实能减少重复阅读时使用，并明确禁止继续嵌套派发。"],
  ["send_message", "给已存在的后台子代理发送下一轮消息。消息不会改写它正在进行的当前轮次。"],
  ["interrupt_agent", "请求停止后台子代理的当前轮次。停止请求不删除已经排队的后续消息。"],
  ["list_agents", "列出当前智能体拥有的子代理、状态和最近活动。完成状态只表示该代理轮次结束，不替代主智能体复核证据。"],
  ["report", "向派发你的主智能体报告自包含的阶段发现或最终结果，必须附带证据和未检查范围。"],
  ["workflow", "用 JavaScript/TypeScript 编排重复批处理或有清晰阶段依赖的多项任务。简单单次操作直接调用工具。"],
  ["ralph", "按同一个明确目标启动多轮新代理接力。只有主人明确要求 Ralph 运行时使用。"],
  ["web_search", "搜索当前公开信息并返回来源链接。优先使用已配置的 Exa 搜索；本工具仅作轻量后备。"],
  ["web_fetch", "读取一个公开 HTTP(S) 页面并转成文本。优先使用 Exa 正文抓取或 web-fetcher；本工具仅作轻量后备。"],
  ["run_code", "通过 Code Mode SDK 编排多个工具调用。批量、循环、条件分支、结果复用或并行操作时使用；简单单次动作直接调用对应工具。多行命令和长正文优先作为工具参数或文件内容传递，不要把含反引号、模板占位符或多层引号的 PowerShell 直接嵌进 TypeScript 模板字符串。"],
  ["cordis_inspect_list", "列出当前可用的 Cordis 检查提供方及其只读方法。用于开发 DSH 插件或 Preset 前确认真实宿主能力。"],
  ["cordis_inspect_query", "调用 cordis_inspect_list 已声明的只读检查方法。输入必须符合对应 Schema。"],
  ["cordis_inspect_self", "检查当前会话拥有的动态 Cordis 插件、版本和运行状态。"],
  ["cordis_stop", "停止当前会话拥有的动态 Cordis 插件运行，但保留插件定义和版本。"],
  ["cordis_undefine", "永久删除当前会话拥有的动态 Cordis 插件及其版本和授权。属于高风险操作，必须得到主人对具体插件的明确授权。"],
  ["str_replace_editor", "通过查看、创建或字面量替换编辑文本文件。它只用于极简或官方救援模式；自定义主力模式使用 apply_patch。"],
  ["apply_patch", "使用结构化补丁一次修改一个或多个文本文件。应用前先解析并预检全部路径，任何一项失败都不能留下半套修改。"],
  ["thread_list", "按稳定游标列出当前可访问的 DSH 对话，不加载整段大对话正文。"],
  ["thread_search", "在 DSH 对话的规范化只读缓存中搜索标题或正文，返回原始轮定位符和有限片段。"],
  ["thread_read", "按轮范围读取 DSH 对话原文；大结果分页或写入 artifact，禁止为方便一次性加载整段巨大历史。"],
  ["thread_confirm", "确认本次实际读取后真正有用的原始轮，供下一次压缩重新评估详细度；没有读取资格的轮不能确认。"],
  ["thread_protect", "临时保护指定原始轮在后续压缩中保持详细展示。保护由模型根据主人任务调用，不由界面自动猜测。"],
  ["thread_release_protection", "解除已经不再需要的原始轮保护，避免旧任务内容长期占用详细展示预算。"],
]);

const PARAMETER_WORDS = new Map([
  ["file_path", "文件路径"],
  ["offset", "从第几行或第几个位置开始"],
  ["limit", "本次最多读取或返回多少项"],
  ["path", "文件或目录路径"],
  ["content", "要写入或记录的正文"],
  ["old_string", "必须在目标文件中精确出现的原文字面量"],
  ["new_string", "用于替换原文字面量的新内容"],
  ["replace_all", "是否替换所有精确匹配；默认只允许唯一匹配"],
  ["pattern", "搜索模式"],
  ["include", "文件过滤模式"],
  ["command", "要执行的命令"],
  ["description", "这次操作的简短用途说明"],
  ["timeout", "超时时间"],
  ["timeout_ms", "最长等待毫秒数"],
  ["run_in_background", "是否作为后台任务运行"],
  ["wait", "是否等待结果"],
  ["task_id", "后台任务编号"],
  ["job_id", "启动后台任务时返回的任务编号"],
  ["reason", "停止、解除或变更操作的简短原因"],
  ["agent_id", "子代理编号"],
  ["prompt", "交给子代理或工作流的完整任务说明"],
  ["task", "要完成的具体子任务"],
  ["agent_type", "子代理角色或预设类型"],
  ["fork_context", "是否继承当前对话上下文"],
  ["items", "显式提供给子代理的文本、图片或文件材料"],
  ["provider", "模型提供方"],
  ["model", "模型名称"],
  ["reasoning_effort", "模型思考强度"],
  ["max_tokens", "最大输出 Token 数"],
  ["query", "要搜索的关键词或自然语言问题"],
  ["url", "要读取的公开网页地址"],
  ["code", "要在 Code Mode 中执行的 TypeScript 程序"],
  ["questions", "需要主人决定的一到三个结构化问题"],
  ["question", "向主人展示的单句问题"],
  ["header", "问题的简短标题"],
  ["options", "互斥的候选选项"],
  ["label", "选项的简短名称"],
  ["todos", "替换当前短期看板的完整任务列表"],
  ["status", "当前状态"],
  ["goal_id", "当前 Goal 的稳定编号"],
  ["revision", "调用前读取到的 Goal 版本号"],
  ["action", "要执行的生命周期操作"],
  ["objective", "需要跨轮持续完成的明确目标"],
  ["blocked_reason", "同一阻塞条件连续存在至少三个 Goal 轮次后的具体说明"],
  ["plan", "提交给主人审批的完整实施计划"],
  ["script", "工作流要执行的纯 JavaScript 程序正文"],
  ["meta", "工作流身份与配置元数据，只能填写普通 JSON"],
  ["maxRounds", "Ralph 最多运行多少轮，必须是部署上限内的正整数"],
  ["output", "提交给直接派发者的完整报告正文"],
  ["message", "要发送的消息正文"],
  ["pluginId", "动态 Cordis 插件的稳定编号"],
  ["packageId", "动态 Cordis 插件某个不可变源码版本的编号"],
  ["platform", "检查提供方所在的平台"],
  ["method", "要调用的只读检查方法"],
  ["input", "传给检查方法的结构化输入"],
  ["conversation_id", "DSH 对话的稳定编号"],
  ["cursor", "继续读取同一稳定快照的游标"],
  ["start_round", "开始读取的原始轮号"],
  ["end_round", "结束读取的原始轮号"],
  ["round_ids", "本次确认、保护或解除保护的原始轮编号"],
  ["read_receipt_id", "证明这些轮已在本次请求中真实可见的读取回执编号"],
]);

function translateRegisteredText(registry, name, text) {
  if (typeof text === "string" && text.trim().length === 0) return text;
  const translation = registry.get(name);
  if (typeof translation === "function") return translation(text);
  return translation ?? text;
}

function descriptionPairs(original, translated, pairs) {
  if (original === null || translated === null || typeof original !== "object" || typeof translated !== "object") return;
  if (Array.isArray(original) || Array.isArray(translated)) {
    if (!Array.isArray(original) || !Array.isArray(translated)) return;
    for (let index = 0; index < Math.min(original.length, translated.length); index += 1) {
      descriptionPairs(original[index], translated[index], pairs);
    }
    return;
  }
  if (typeof original.description === "string" && typeof translated.description === "string") {
    const before = original.description.replace(/\s+/g, " ").trim();
    const after = translated.description.replace(/\s+/g, " ").trim();
    if (before && after && before !== after) pairs.set(before, after);
  }
  for (const key of Object.keys(original)) {
    if (Object.hasOwn(translated, key)) descriptionPairs(original[key], translated[key], pairs);
  }
}

function translateSdkSection(text, originalTools, translatedTools) {
  const codeFence = text.indexOf("```");
  if (codeFence < 0) return "Code Mode SDK 当前没有生成可用的类型声明，不能猜测工具调用格式。";
  const python = text.slice(0, codeFence).includes("Python");
  const header = python
    ? "## 在 run_code 中编写 Python\n\nrun_code 需要 code 与 description 两个参数。code 是异步 Python 函数正文，支持顶层 await 和 return；运行时只提供 tools 与 ToolCallError，其余类型声明只是静态提示，不能当作真实构造器。通过 await tools.name(args) 调用工具，失败会抛出 ToolCallError。互相独立的只读调用可以用 asyncio.gather 并行，有依赖或会修改状态的操作必须按顺序 await。不要把多个可能返回大文本的工具塞进同一次 gather；先取索引、摘要、统计或 artifact 路径，再分批精读，否则聚合结果可能被截断。只有 print 或 return 的内容会回到对话，因此只提取当前需要的结果。\n\n当前可用工具："
    : "## 在 run_code 中编写 TypeScript\n\nrun_code 需要 code 与 description 两个参数。code 是异步 TypeScript 函数正文，只能使用可擦除类型语法，不能使用 enum 或 namespace；类型标注只作提示，实际运行会移除类型。通过 await tools.name(args) 调用工具，失败会抛出 ToolCallError。互相独立的只读调用可以用 Promise.all 并行，有依赖或会修改状态的操作必须按顺序 await。不要把多个可能返回大文本的工具塞进同一次 Promise.all；先取索引、摘要、统计或 artifact 路径，再分批精读，否则聚合结果可能被截断。只有 console.log 或 return 的内容会回到对话，因此只提取当前需要的结果。\n\n当前可用工具：";
  let code = text.slice(codeFence);
  const pairs = new Map();
  for (let index = 0; index < Math.min(originalTools.length, translatedTools.length); index += 1) {
    descriptionPairs(originalTools[index], translatedTools[index], pairs);
  }
  for (const [before, after] of [...pairs.entries()].sort((left, right) => right[0].length - left[0].length)) {
    code = code.replaceAll(before, after);
  }
  return `${header}\n\n${code}`;
}

export function translateAssembly(assembly) {
  const tools = assembly.tools.map(translateToolSchema);
  return {
    ...assembly,
    sections: assembly.sections.map((section) => ({
      ...section,
      text: section.name === "tools:sdk"
        ? translateSdkSection(section.text, assembly.tools, tools)
        : translateRegisteredText(SECTION_TRANSLATIONS, section.name, section.text),
    })),
    contexts: assembly.contexts.map((context) => ({
      ...context,
      text: translateRegisteredText(CONTEXT_TRANSLATIONS, context.name, context.text),
    })),
    tools,
  };
}

export function translateToolSchema(tool) {
  const owned = TOOL_DESCRIPTIONS.has(tool.name);
  return {
    ...tool,
    description: TOOL_DESCRIPTIONS.get(tool.name) ?? tool.description,
    parameters: translateJsonSchema(tool.parameters, { forceChinese: owned }),
    ...(tool.output === undefined ? {} : { output: translateJsonSchema(tool.output, { forceChinese: owned }) }),
  };
}

export function translateJsonSchema(schema, options = {}, propertyName) {
  if (Array.isArray(schema)) return schema.map((item) => translateJsonSchema(item, options, propertyName));
  if (schema === null || typeof schema !== "object") return schema;
  const translated = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string" && options.forceChinese === true) {
      translated[key] = propertyName !== undefined && PARAMETER_WORDS.has(propertyName)
        ? PARAMETER_WORDS.get(propertyName)
        : "字段说明以当前 Schema 的类型、必填项和取值约束为准。";
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      translated[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => {
        const next = translateJsonSchema(property, options, name);
        if (next && typeof next === "object" && !Array.isArray(next) && PARAMETER_WORDS.has(name)) {
          next.description = PARAMETER_WORDS.get(name);
        }
        return [name, next];
      }));
      continue;
    }
    translated[key] = translateJsonSchema(value, options, propertyName);
  }
  return translated;
}

export function untranslatedToolNames(tools) {
  return tools.filter((tool) => !TOOL_DESCRIPTIONS.has(tool.name)).map((tool) => tool.name).sort();
}

export { CONTEXT_TRANSLATIONS, SECTION_TRANSLATIONS, TOOL_DESCRIPTIONS };
